// SPDX-License-Identifier: GPL-2.0-or-later
//
// NordVPN toggle for the GNOME Shell Quick Settings menu.
//
// Based on "NordVPN Quick Toggle" by Wedaxi
// (https://github.com/Wedaxi/NordVPN-Quick-Toggle), GPL-2.0-or-later.
// Not affiliated with NordVPN.

import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import Shell from 'gi://Shell';
import St from 'gi://St';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';
import {Extension, gettext as _} from 'resource:///org/gnome/shell/extensions/extension.js';
import {QuickMenuToggle, SystemIndicator} from 'resource:///org/gnome/shell/ui/quickSettings.js';

Gio._promisify(Gio.Subprocess.prototype, 'communicate_utf8_async');
Gio._promisify(Gio.File.prototype, 'load_contents_async');
Gio._promisify(Gio.File.prototype, 'replace_contents_bytes_async', 'replace_contents_finish');

const CLI = 'nordvpn';
const GUI_DESKTOP_ID = 'nordvpn-gui.desktop';
const MAX_RECENTS = 4;
const POLL_IDLE_MS = 30_000;
const POLL_BUSY_MS = 1_500;
const NETWORK_CHANGE_DELAY_MS = 500;

const State = Object.freeze({
    CONNECTED: 'connected',
    CONNECTING: 'connecting',
    DISCONNECTING: 'disconnecting',
    DISCONNECTED: 'disconnected',
    UNAVAILABLE: 'unavailable',
});

// ---------------------------------------------------------------------------
// nordvpn CLI helpers
// ---------------------------------------------------------------------------

function classifyError(text) {
    if (/permission denied/i.test(text))
        return 'permission';
    if (/not logged in/i.test(text))
        return 'login';
    if (/daemon|nordvpnd|socket/i.test(text))
        return 'daemon';
    return 'other';
}

class CliError extends Error {
    constructor(message, kind = classifyError(message)) {
        super(message);
        this.name = 'CliError';
        this.kind = kind;
    }
}

function isCancelled(error) {
    return error instanceof GLib.Error &&
        error.matches(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED);
}

/** Short label and longer explanation for an error, for the UI. */
function describeError(error) {
    switch (error?.kind) {
    case 'missing':
        return [_('Not installed'),
            _('The nordvpn command was not found. Install the NordVPN app.')];
    case 'permission':
        return [_('No permission'),
            _('Your user is not in the nordvpn group. Run “sudo usermod -aG nordvpn $USER”, then log out and back in.')];
    case 'daemon':
        return [_('Service not running'),
            _('The NordVPN service is not running. Start it with “sudo systemctl enable --now nordvpnd”.')];
    case 'login':
        return [_('Not logged in'), _('Log in with the NordVPN app.')];
    default:
        return [_('Error'), error?.message || _('Unknown error')];
    }
}

/** Drop spinner frames and terminal escape codes the CLI may print. */
function cleanOutput(text) {
    return text
        .replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '') // eslint-disable-line no-control-regex
        .split('\n')
        .map(line => line.replace(/\r+$/, ''))
        .map(line => line.slice(line.lastIndexOf('\r') + 1).trim())
        .filter(line => line && !/^[-\\|/]$/.test(line))
        .join('\n');
}

/**
 * Run `nordvpn <args>` without blocking the shell.
 *
 * @param {string[]} args - CLI arguments
 * @param {Gio.Cancellable} cancellable - cancels waiting for the output
 * @returns {Promise<string>} cleaned stdout + stderr
 */
async function runCli(args, cancellable) {
    let proc;
    try {
        proc = Gio.Subprocess.new([CLI, ...args],
            Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_MERGE);
    } catch (e) {
        throw new CliError(e.message, 'missing');
    }

    const [stdout] = await proc.communicate_utf8_async(null, cancellable);
    const output = cleanOutput(stdout ?? '');
    if (!proc.get_successful())
        throw new CliError(output || `nordvpn ${args.join(' ')} failed`);
    return output;
}

/** Parse `nordvpn status` ("Key: Value" lines) into {key: value}. */
function parseStatus(text) {
    const info = {};
    for (const line of text.split('\n')) {
        const sep = line.indexOf(':');
        if (sep > 0)
            info[line.slice(0, sep).trim().toLowerCase()] = line.slice(sep + 1).trim();
    }
    return info;
}

// Names are passed to `nordvpn connect` as arguments, so never accept
// anything that could be read as an option or contains whitespace.
const toArg = name => name.trim().replace(/\s+/g, '_');
const isValidArg = arg => /^[^\s-]\S*$/.test(arg);
const pretty = name => name.replaceAll('_', ' ');
const sameName = (a, b) => !!a && !!b && pretty(a).toLowerCase() === pretty(b).toLowerCase();

/** Parse `nordvpn countries` / `nordvpn cities X` output into names. */
function parseList(text) {
    return text.split(/[\n,]/)
        .flatMap(line => line.split(/\t+|\s{2,}/))
        .map(item => item.trim())
        // skip notices such as "A new version is available!"
        .filter(item => item && !/[.!?:]$/.test(item) && item.split(/\s+/).length <= 4)
        .map(toArg)
        .filter(isValidArg);
}

/** A connect target is [] (recommended), [country] or [country, city]. */
function isValidTarget(target) {
    return Array.isArray(target) && target.length <= 2 &&
        target.every(arg => typeof arg === 'string' && isValidArg(arg));
}

function targetLabel(target) {
    const [country, city] = target;
    if (city)
        return `${pretty(city)}, ${pretty(country)}`;
    return country ? pretty(country) : _('Recommended server');
}

// ---------------------------------------------------------------------------
// Recent locations, kept in ~/.local/state/nordvpn-toggle/recent.json
// ---------------------------------------------------------------------------

class RecentLocations {
    constructor() {
        this._file = Gio.File.new_for_path(GLib.build_filenamev(
            [GLib.get_user_state_dir(), 'nordvpn-toggle', 'recent.json']));
        this.items = [];
    }

    async load() {
        try {
            const [bytes] = await this._file.load_contents_async(null);
            const data = JSON.parse(new TextDecoder().decode(bytes));
            if (Array.isArray(data))
                this.items = data.filter(t => isValidTarget(t) && t.length > 0).slice(0, MAX_RECENTS);
        } catch (e) {
            if (!(e instanceof GLib.Error && e.matches(Gio.IOErrorEnum, Gio.IOErrorEnum.NOT_FOUND)))
                console.warn(`nordvpn-toggle: could not read recent locations: ${e.message}`);
        }
    }

    add(target) {
        const key = JSON.stringify(target);
        this.items = [target, ...this.items.filter(t => JSON.stringify(t) !== key)]
            .slice(0, MAX_RECENTS);
        this._save().catch(e =>
            console.warn(`nordvpn-toggle: could not save recent locations: ${e.message}`));
    }

    async _save() {
        GLib.mkdir_with_parents(this._file.get_parent().get_path(), 0o700);
        const bytes = new GLib.Bytes(new TextEncoder().encode(JSON.stringify(this.items)));
        await this._file.replace_contents_bytes_async(bytes, null, false,
            Gio.FileCreateFlags.REPLACE_DESTINATION, null);
    }
}

// ---------------------------------------------------------------------------
// UI
// ---------------------------------------------------------------------------

const LocationItem = GObject.registerClass(
class LocationItem extends PopupMenu.PopupBaseMenuItem {
    _init(text, {leadingIcon = null, trailingIcon = null} = {}) {
        super._init();

        if (leadingIcon) {
            this.add_child(new St.Icon({
                icon_name: leadingIcon,
                style_class: 'popup-menu-icon',
            }));
        }

        this.label = new St.Label({
            text,
            x_expand: true,
            y_align: Clutter.ActorAlign.CENTER,
        });
        this.add_child(this.label);
        this.label_actor = this.label;
        this.set_child_above_sibling(this._ornamentIcon, this.label);

        if (trailingIcon) {
            this.add_child(new St.Icon({
                icon_name: trailingIcon,
                style_class: 'popup-menu-icon',
            }));
        }
    }

    setCurrent(current) {
        this.setOrnament(current ? PopupMenu.Ornament.CHECK : PopupMenu.Ornament.HIDDEN);
    }
});

const NordVpnToggle = GObject.registerClass(
class NordVpnToggle extends QuickMenuToggle {
    constructor(icon) {
        super({title: 'NordVPN', gicon: icon, toggleMode: false});

        this._icon = icon;
        this._cancellable = new Gio.Cancellable();
        this._destroyed = false;

        this._state = State.DISCONNECTED;
        this._info = {};
        this._error = null;
        this._loginRequired = false;
        this._pending = null; // 'connect' | 'disconnect' while a command runs
        this._opSerial = 0;

        this._refreshId = 0;
        this._refreshing = false;
        this._refreshQueued = false;
        this._idleIds = new Set();

        this._countries = null;
        this._countriesLoading = false;
        this._countriesError = null;
        this._cities = new Map(); // country -> string[] | CliError | 'loading'
        this._viewCountry = null;
        this._locationKey = '';

        this._recents = new RecentLocations();

        this._buildMenu();

        this.connect('clicked', () => this._onClicked());
        this.connect('destroy', () => this._onDestroy());

        Gio.NetworkMonitor.get_default().connectObject('network-changed',
            () => this._scheduleRefresh(NETWORK_CHANGE_DELAY_MS), this);
        Main.panel.statusArea.quickSettings.menu.connectObject('open-state-changed',
            (menu, open) => {
                if (open)
                    this._scheduleRefresh(0);
            }, this);

        this._recents.load().then(() => {
            if (!this._destroyed)
                this._syncRecents();
        });

        this._sync();
        this._scheduleRefresh(0);
    }

    // -- menu ---------------------------------------------------------------

    _buildMenu() {
        this.menu.setHeader(this._icon, 'NordVPN');

        this._recentSection = new PopupMenu.PopupMenuSection();
        this.menu.addMenuItem(this._recentSection);

        this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem(_('Locations')));

        this._searchEntry = new St.Entry({
            style_class: 'nordvpn-search-entry',
            hint_text: _('Search…'),
            can_focus: true,
            x_expand: true,
            primary_icon: new St.Icon({
                icon_name: 'edit-find-symbolic',
                style_class: 'nordvpn-search-icon',
            }),
        });
        this._searchEntry.clutter_text.connect('text-changed', () => this._rebuildList());
        this._searchEntry.clutter_text.connect('activate', () => this._firstMatch?.());

        const searchItem = new PopupMenu.PopupBaseMenuItem({
            reactive: false,
            can_focus: false,
            style_class: 'nordvpn-search-item',
        });
        searchItem.remove_style_class_name('popup-inactive-menu-item');
        searchItem.add_child(this._searchEntry);
        this.menu.addMenuItem(searchItem);

        // The location list lives in its own, unparented section inside a
        // scroll view: activating a country only drills down instead of
        // closing the menu. Connecting closes the menu explicitly.
        this._listSection = new PopupMenu.PopupMenuSection();
        this._scroll = new St.ScrollView({
            style_class: 'nordvpn-location-list',
            hscrollbar_policy: St.PolicyType.NEVER,
            vscrollbar_policy: St.PolicyType.AUTOMATIC,
            overlay_scrollbars: true,
            child: this._listSection.actor,
        });
        const listHolder = new PopupMenu.PopupMenuSection();
        listHolder.actor.add_child(this._scroll);
        this.menu.addMenuItem(listHolder);

        this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());
        this._guiItem = this.menu.addAction(_('Open NordVPN'), () => this._openGui());
        this._guiItem.visible = !!Shell.AppSystem.get_default().lookup_app(GUI_DESKTOP_ID);

        this.menu.connect('open-state-changed', (menu, open) => {
            if (open) {
                this._setView(null);
                this._ensureCountries();
            }
        });

        this._rebuildList();
    }

    _setView(country) {
        this._viewCountry = country;
        this._searchEntry.text = ''; // rebuilds through text-changed if not empty
        this._rebuildList();
        this._scroll.vadjustment.value = 0;
        if (country)
            this._ensureCities(country);
    }

    _addInfoRow(text) {
        this._listSection.addMenuItem(new PopupMenu.PopupMenuItem(text, {reactive: false}));
    }

    _addErrorRow(error) {
        this._addInfoRow(error.kind === 'other' ? error.message : describeError(error)[0]);
    }

    _addLocationRow(text, options, onActivate) {
        const item = new LocationItem(text, options);
        item.connect('activate', onActivate);
        this._listSection.addMenuItem(item);
        return item;
    }

    _rebuildList() {
        this._listSection.removeAll();
        this._firstMatch = null;

        const query = this._searchEntry.text.trim().toLowerCase();
        const matches = name => !query || pretty(name).toLowerCase().includes(query);
        const connected = this._state === State.CONNECTED ? this._info : null;

        if (this._viewCountry === null) {
            if (!query)
                this._addLocationRow(_('Recommended server'), {}, () => this._connectFromList([]));

            if (this._countriesError) {
                this._addErrorRow(this._countriesError);
                return;
            }
            if (!this._countries) {
                this._addInfoRow(_('Loading…'));
                return;
            }

            const shown = this._countries.filter(matches);
            if (!shown.length)
                this._addInfoRow(_('No matches'));
            for (const country of shown) {
                const open = () => this._defer(() => this._setView(country));
                this._firstMatch ??= open;
                const item = this._addLocationRow(pretty(country),
                    {trailingIcon: 'go-next-symbolic'}, open);
                item.setCurrent(sameName(country, connected?.country));
            }
            return;
        }

        const country = this._viewCountry;
        this._addLocationRow(pretty(country), {leadingIcon: 'go-previous-symbolic'},
            () => this._defer(() => this._setView(null)));
        if (!query) {
            this._addLocationRow(_('Recommended server'), {},
                () => this._connectFromList([country]));
        }

        const cities = this._cities.get(country);
        if (cities === undefined || cities === 'loading') {
            this._addInfoRow(_('Loading…'));
            return;
        }
        if (cities instanceof Error) {
            this._addErrorRow(cities);
            return;
        }

        const shown = cities.filter(matches);
        if (!shown.length)
            this._addInfoRow(_('No matches'));
        for (const city of shown) {
            const connect = () => this._connectFromList([country, city]);
            this._firstMatch ??= connect;
            const item = this._addLocationRow(pretty(city), {}, connect);
            item.setCurrent(sameName(country, connected?.country) && sameName(city, connected?.city));
        }
    }

    _syncRecents() {
        this._recentSection.removeAll();
        if (!this._recents.items.length)
            return;

        this._recentSection.addMenuItem(new PopupMenu.PopupSeparatorMenuItem(_('Recent')));
        for (const target of this._recents.items) {
            const item = new LocationItem(targetLabel(target),
                {leadingIcon: 'document-open-recent-symbolic'});
            item.connect('activate', () => this._connect(target));
            this._recentSection.addMenuItem(item);
        }
    }

    async _ensureCountries() {
        if (this._countries?.length || this._countriesLoading)
            return;

        this._countriesLoading = true;
        this._countriesError = null;
        this._rebuildList();
        try {
            this._countries = parseList(await runCli(['countries'], this._cancellable));
        } catch (e) {
            if (isCancelled(e))
                return;
            this._countriesError = e;
        } finally {
            this._countriesLoading = false;
        }
        if (!this._destroyed)
            this._rebuildList();
    }

    async _ensureCities(country) {
        const cached = this._cities.get(country);
        if (Array.isArray(cached) || cached === 'loading')
            return;

        this._cities.set(country, 'loading');
        try {
            this._cities.set(country, parseList(await runCli(['cities', country], this._cancellable)));
        } catch (e) {
            if (isCancelled(e))
                return;
            this._cities.set(country, e);
        }
        if (!this._destroyed && this._viewCountry === country)
            this._rebuildList();
    }

    _openGui() {
        const app = Shell.AppSystem.get_default().lookup_app(GUI_DESKTOP_ID);
        if (!app)
            return;
        Main.overview.hide();
        Main.panel.closeQuickSettings();
        app.activate();
    }

    // -- state ----------------------------------------------------------------

    _displayState() {
        if (this._pending === 'connect')
            return State.CONNECTING;
        if (this._pending === 'disconnect')
            return State.DISCONNECTING;
        return this._state;
    }

    _sync() {
        const state = this._displayState();
        const info = this._info;
        const server = info.hostname?.split('.')[0] ?? '';
        const location = [info.city, info.country].filter(Boolean).join(', ');

        let subtitle = null;
        let header;
        switch (state) {
        case State.CONNECTED:
            subtitle = info.country || info.server || null;
            header = [location || _('Connected'), server].filter(Boolean).join(' · ');
            break;
        case State.CONNECTING:
            subtitle = header = _('Connecting…');
            break;
        case State.DISCONNECTING:
            subtitle = header = _('Disconnecting…');
            break;
        case State.UNAVAILABLE:
            subtitle = header = describeError(this._error)[0];
            break;
        default:
            header = _('Disconnected');
            if (this._loginRequired)
                subtitle = header = _('Not logged in');
        }

        this.checked = state === State.CONNECTED || state === State.CONNECTING;
        this.subtitle = subtitle;
        this.menu.setHeader(this._icon, 'NordVPN', header);
    }

    _applyStatus(info) {
        const status = (info.status ?? '').toLowerCase();
        if (status === 'connected')
            this._state = State.CONNECTED;
        else if (status.includes('connecting') && !status.startsWith('disconnect'))
            this._state = State.CONNECTING;
        else
            this._state = State.DISCONNECTED;

        this._info = this._state === State.CONNECTED ? info : {};
        this._error = null;
        if (this._state === State.CONNECTED)
            this._loginRequired = false;
        this._syncLocationMarks();
        this._sync();
    }

    _applyError(error) {
        this._state = State.UNAVAILABLE;
        this._info = {};
        this._error = error;
        this._syncLocationMarks();
        this._sync();
    }

    _syncLocationMarks() {
        const key = this._state === State.CONNECTED
            ? `${this._info.country}|${this._info.city}` : '';
        if (key === this._locationKey)
            return;
        this._locationKey = key;
        if (this.menu.isOpen)
            this._rebuildList();
    }

    _scheduleRefresh(delayMs) {
        if (this._destroyed)
            return;
        if (this._refreshId)
            GLib.Source.remove(this._refreshId);
        this._refreshId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, delayMs, () => {
            this._refreshId = 0;
            this._refresh();
            return GLib.SOURCE_REMOVE;
        });
    }

    async _refresh() {
        if (this._refreshing) {
            this._refreshQueued = true;
            return;
        }

        this._refreshing = true;
        try {
            this._applyStatus(parseStatus(await runCli(['status'], this._cancellable)));
        } catch (e) {
            if (isCancelled(e))
                return;
            this._applyError(e);
        } finally {
            this._refreshing = false;
        }

        if (this._destroyed)
            return;
        if (this._refreshQueued) {
            this._refreshQueued = false;
            this._scheduleRefresh(0);
            return;
        }
        const busy = this._pending !== null || this._state === State.CONNECTING;
        this._scheduleRefresh(busy ? POLL_BUSY_MS : POLL_IDLE_MS);
    }

    // -- actions ----------------------------------------------------------------

    _onClicked() {
        if (this._state === State.UNAVAILABLE) {
            this._notifyError(_('NordVPN is not available'), this._error);
            this._scheduleRefresh(0);
            return;
        }

        const state = this._displayState();
        if (state === State.CONNECTED || state === State.CONNECTING)
            this._disconnect();
        else if (state === State.DISCONNECTED)
            this._connect(this._recents.items[0] ?? []);
    }

    _connectFromList(target) {
        this.menu.close();
        this._connect(target);
    }

    _connect(target) {
        return this._runCommand('connect', ['connect', ...target],
            _('Could not connect to NordVPN'), () => {
                if (target.length) {
                    this._recents.add(target);
                    this._syncRecents();
                }
            });
    }

    _disconnect() {
        return this._runCommand('disconnect', ['disconnect'],
            _('Could not disconnect from NordVPN'));
    }

    async _runCommand(pending, args, errorTitle, onSuccess = null) {
        const serial = ++this._opSerial;
        this._pending = pending;
        if (pending === 'connect')
            this._loginRequired = false;
        this._sync();
        this._scheduleRefresh(POLL_BUSY_MS);

        try {
            await runCli(args, this._cancellable);
            if (serial === this._opSerial)
                onSuccess?.();
        } catch (e) {
            if (isCancelled(e) || serial !== this._opSerial)
                return;
            if (e.kind === 'login')
                this._loginRequired = true;
            this._notifyError(errorTitle, e);
        } finally {
            if (!this._destroyed && serial === this._opSerial) {
                this._pending = null;
                this._sync();
                this._scheduleRefresh(0);
            }
        }
    }

    _notifyError(title, error) {
        Main.notifyError(title, describeError(error)[1]);
    }

    _defer(callback) {
        const id = GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
            this._idleIds.delete(id);
            callback();
            return GLib.SOURCE_REMOVE;
        });
        this._idleIds.add(id);
    }

    _onDestroy() {
        this._destroyed = true;
        this._cancellable.cancel();
        if (this._refreshId)
            GLib.Source.remove(this._refreshId);
        this._refreshId = 0;
        for (const id of this._idleIds)
            GLib.Source.remove(id);
        this._idleIds.clear();
    }
});

const NordVpnIndicator = GObject.registerClass(
class NordVpnIndicator extends SystemIndicator {
    constructor(extension) {
        super();

        const icon = new Gio.FileIcon({
            file: extension.dir.resolve_relative_path('icons/nordvpn-symbolic.svg'),
        });

        this._indicator = this._addIndicator();
        this._indicator.gicon = icon;

        const toggle = new NordVpnToggle(icon);
        toggle.bind_property('checked', this._indicator, 'visible',
            GObject.BindingFlags.SYNC_CREATE);
        this.quickSettingsItems.push(toggle);
    }
});

export default class NordVpnToggleExtension extends Extension {
    enable() {
        this._indicator = new NordVpnIndicator(this);
        Main.panel.statusArea.quickSettings.addExternalIndicator(this._indicator);
    }

    disable() {
        this._indicator.quickSettingsItems.forEach(item => item.destroy());
        this._indicator.destroy();
        this._indicator = null;
    }
}

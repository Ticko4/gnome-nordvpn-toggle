#!/usr/bin/env bash
# Install (or update) NordVPN Toggle for the current user.
#   ./install.sh          install into ~/.local/share/gnome-shell/extensions
#   ./install.sh --pack   build the zip to upload to extensions.gnome.org
set -euo pipefail

UUID="nordvpn-toggle@ticko4.github.io"
OLD_UUID="nordvpn-toggle@local"   # pre-release name, removed below
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SRC="$ROOT/$UUID"

if [[ "${1:-}" == "--pack" ]]; then
    gnome-extensions pack "$SRC" --force --out-dir "$ROOT" --extra-source=icons
    echo "Package: $ROOT/$UUID.shell-extension.zip"
    echo "Upload it at https://extensions.gnome.org/upload/"
    exit 0
fi

EXT_DIR="${XDG_DATA_HOME:-$HOME/.local/share}/gnome-shell/extensions"
DEST="$EXT_DIR/$UUID"
rm -rf "$DEST"
mkdir -p "$EXT_DIR"
cp -r "$SRC" "$DEST"
echo "Installed in $DEST"

# Before publishing the extension was called $OLD_UUID: remove that copy.
if [[ -d "$EXT_DIR/$OLD_UUID" ]]; then
    rm -rf "${EXT_DIR:?}/$OLD_UUID"
    echo "Removed the old copy ($OLD_UUID)"
fi

# Mark the extension as enabled (replacing the old UUID). On Wayland the
# running shell only picks up new extensions at the next login.
gjs -c "
    const {Gio} = imports.gi;
    const s = new Gio.Settings({schema_id: 'org.gnome.shell'});
    const on = s.get_strv('enabled-extensions').filter(u => u !== '$OLD_UUID');
    if (!on.includes('$UUID'))
        on.push('$UUID');
    s.set_strv('enabled-extensions', on);
    s.set_strv('disabled-extensions',
        s.get_strv('disabled-extensions').filter(u => u !== '$UUID' && u !== '$OLD_UUID'));
    Gio.Settings.sync();
"

if ! command -v nordvpn >/dev/null; then
    echo "Note: the nordvpn command was not found. Install the NordVPN app for Linux first."
elif ! getent group nordvpn | cut -d: -f4 | tr ',' '\n' | grep -qx "$(id -un)"; then
    echo "Note: add yourself to the nordvpn group: sudo usermod -aG nordvpn \$USER"
fi

if gnome-extensions info "$UUID" >/dev/null 2>&1; then
    gnome-extensions enable "$UUID"
    echo "Enabled. If it was already running, log out and back in to load the new version."
else
    echo "Enabled for the next login: log out and back in to see it in Quick Settings."
fi

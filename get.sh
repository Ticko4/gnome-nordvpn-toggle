#!/usr/bin/env bash
# Install or update NordVPN Toggle from the latest GitHub release, no build tools needed:
#   curl -fsSL https://raw.githubusercontent.com/Ticko4/gnome-nordvpn-toggle/main/get.sh | bash
set -euo pipefail

UUID="nordvpn-toggle@ticko4.github.io"
URL="${NT_ZIP_URL:-https://github.com/Ticko4/gnome-nordvpn-toggle/releases/latest/download/nordvpn-toggle.zip}"
SUPPORTED="51"   # keep in sync with "shell-version" in metadata.json

shell="$(gnome-shell --version 2>/dev/null | grep -oE '[0-9]+' | head -n1 || true)"
if [[ -z "$shell" ]]; then
    echo "GNOME Shell was not found: NordVPN Toggle is a GNOME Shell extension." >&2
    exit 1
fi
if [[ " $SUPPORTED " != *" $shell "* ]]; then
    echo "NordVPN Toggle supports GNOME Shell $SUPPORTED; this system has GNOME Shell $shell." >&2
    exit 1
fi

tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT
zip="$tmp/nordvpn-toggle.zip"
echo "Downloading $URL"
if command -v curl >/dev/null; then
    curl -fsSL -o "$zip" "$URL"
elif command -v wget >/dev/null; then
    wget -qO "$zip" "$URL"
else
    gio copy "$URL" "$zip"
fi

# Unpacks into ~/.local/share/gnome-shell/extensions.
gnome-extensions install --force "$zip"

# Mark it enabled so it starts at the next login (the running shell on Wayland
# only loads new extensions at login).
gjs -c "
    const {Gio} = imports.gi;
    const s = new Gio.Settings({schema_id: 'org.gnome.shell'});
    const on = s.get_strv('enabled-extensions');
    if (!on.includes('$UUID'))
        s.set_strv('enabled-extensions', [...on, '$UUID']);
    s.set_strv('disabled-extensions', s.get_strv('disabled-extensions').filter(u => u !== '$UUID'));
    Gio.Settings.sync();
"

if [[ "$(gsettings get org.gnome.shell disable-user-extensions 2>/dev/null)" == "true" ]]; then
    echo "Note: extensions are switched off in the Extensions app; switch them on to see NordVPN Toggle."
fi
if ! command -v nordvpn >/dev/null; then
    echo "Note: the nordvpn command was not found. Install the NordVPN app for Linux first."
elif ! getent group nordvpn | cut -d: -f4 | tr ',' '\n' | grep -qx "$(id -un)"; then
    echo "Note: add yourself to the nordvpn group: sudo usermod -aG nordvpn \$USER"
fi
if gnome-extensions info "$UUID" >/dev/null 2>&1; then
    echo "NordVPN Toggle updated: log out and back in to load the new version."
else
    echo "NordVPN Toggle installed: log out and back in to see it in Quick Settings."
fi

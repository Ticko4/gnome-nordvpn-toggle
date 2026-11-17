#!/usr/bin/env bash
# Regenerate po/nordvpn-toggle.pot from the sources. xgettext is run on a copy
# outside the git checkout (newer xgettext versions query git and choke on it).
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
UUID="nordvpn-toggle@ticko4.github.io"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
mkdir -p "$TMP/$UUID"
cp "$ROOT/$UUID"/*.js "$TMP/$UUID/"
cd "$TMP"
xgettext --from-code=UTF-8 --language=JavaScript \
    --keyword=_ --keyword=N_ --keyword=ngettext:1,2 --keyword=pgettext:1c,2 \
    --add-comments=TRANSLATORS: --package-name="NordVPN Toggle" \
    --msgid-bugs-address="https://github.com/Ticko4/gnome-nordvpn-toggle/issues" \
    -o "$ROOT/po/nordvpn-toggle.pot" "$UUID"/*.js
for po in "$ROOT"/po/*.po; do
    [[ -e "$po" ]] && msgmerge --quiet --update --backup=none "$po" "$ROOT/po/nordvpn-toggle.pot"
done
echo "Updated $ROOT/po/nordvpn-toggle.pot"

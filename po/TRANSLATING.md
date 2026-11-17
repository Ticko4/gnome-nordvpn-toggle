# Translating NordVPN Toggle

NordVPN Toggle is a GNOME Shell extension: a NordVPN toggle in the Quick Settings menu, with a menu of
recent locations and a searchable list of countries and cities.

- Template: `po/nordvpn-toggle.pot` (regenerate with `po/update-pot.sh`).
- One file per language: `po/<lang>.po`, using GNOME's language codes (`pt` is European Portuguese,
  `pt_BR` Brazilian, `zh_CN`, `zh_TW`, `sr` is Cyrillic…).
- Check your file: `msgfmt --check -o /dev/null po/<lang>.po` and `python3 po/check_po.py po/<lang>.po`.
- `po/pt_BR.po` is a complete translation you can look at for context.

## Style

- Follow the terminology the GNOME desktop already uses in your language for network states (connected,
  connecting…, disconnected) and for common words (search, loading, recent).
- Sentence case and short labels, as in GNOME. No trailing period on labels; full sentences (the
  notification texts) end with a period.
- Keep `…` where the source has it. Use your language's quotation marks in place of “ ”.
- Do not translate: `NordVPN` (product name), `nordvpn` (the command and the group name) and the
  commands `sudo usermod -aG nordvpn $USER` and `sudo systemctl enable --now nordvpnd`.

## Where each string appears

Toggle in Quick Settings (short status under the title “NordVPN”, keep them short):
- `Connecting…`, `Disconnecting…` — while a connection is being made or closed.
- `Not installed`, `No permission`, `Service not running`, `Not logged in`, `Error` — when NordVPN
  cannot be used.

Menu (opened with the arrow next to the toggle):
- Header subtitle: `Connected`, `Connecting…`, `Disconnecting…`, `Disconnected`, or one of the statuses
  above. When connected it shows the city, country and server instead (from NordVPN, not translated).
- `Recent` — heading above the locations used most recently.
- `Locations` — heading above the search field and the list of countries (and of the cities of a
  country).
- `Search…` — placeholder of the search field that filters the list.
- `Recommended server` — first row of the list: connect to the server NordVPN recommends (usually the
  fastest), anywhere or in the chosen country.
- `Loading…`, `No matches` — shown in the list while it loads or when the search finds nothing.
- `Open NordVPN` — opens the NordVPN app.

Notifications (title, then text):
- `Could not connect to NordVPN`, `Could not disconnect from NordVPN`, `NordVPN is not available`.
- `The nordvpn command was not found. Install the NordVPN app.`
- `Your user is not in the nordvpn group. Run “sudo usermod -aG nordvpn $USER”, then log out and back in.`
- `The NordVPN service is not running. Start it with “sudo systemctl enable --now nordvpnd”.`
- `Log in with the NordVPN app.`
- `Unknown error` — when the error has no message.

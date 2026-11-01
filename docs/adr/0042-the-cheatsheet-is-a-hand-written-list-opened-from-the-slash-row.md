# The Cheatsheet is a hand-written list, opened only from the slash row

`/cheatsheet` is a Command — Gots's own, which never reaches the agent — that opens the Cheatsheet: the keys a hardware keyboard can answer in Gots and what each does. Its rows come from a hand-written, import-free module that takes the switches that gate it as arguments, rather than from a keybinding registry: the app's bindings are scattered across its components with no single owner, and extracting one would fan a refactor across every feature that answers a key inside a feature pull request. The Alt+1…9 row appears only while that switch is on, so the sheet never advertises a dead binding — the switch defaults off. A key whose meaning a switch picks is drawn the way that switch leaves it, which is how the composer's Enter reads as the send or as a new line by `sendOnEnter` (ADR 0078). Entry is the slash row alone: a bare `?` trigger would hijack a lone question mark, and both `?` and Cmd/Ctrl+/ already belong to the host's own desktop app, which Gots is not.

## Considered options

- **A keybinding registry** that every handler and the sheet read — rejected: a wide refactor across the composer, the attachment viewer, the voice bar, research, the project forms and the bot switcher, shipped inside a feature change.
- **A drift-guard test** string-matching each listed combo against its handler's source — rejected: brittle; it fails on refactors that change no behaviour.
- **Listing the Gots commands beside the keys** — rejected: the Slash menu already owns the commands and the bot's skills; two surfaces naming them would drift apart.
- **Advertising Alt+1…9 unconditionally** — rejected: with the switch off by default, the row would tell most users about a shortcut that does nothing.

## Consequences

- The list is edited by hand whenever a handler changes; drift is possible and is fixed where it is found.
- The sheet reads the switch once when it opens and keeps nothing on the device.
- The inventory ships in five groups — Composer, Slash menu, Chat, Navigation, and one for while a viewer or recording is open — and deliberately omits browser-standard Enters.

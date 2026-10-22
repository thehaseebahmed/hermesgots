# MCP servers

A Bot's editor has an MCP tab where its MCP servers live, as its Host reports them: Add a server on
top, the servers the bot's own config holds under *Your servers*, and ones a Hermes plugin provides
under *From plugins*. Each row is a name over its health — a tool count, `Off`, `Connecting…`, the
Host's own failure text, `Click here to authenticate` — and no badge. A row opens the server's own
sheet (Config and Tools); a waiting row's health line is the tap that starts Server access.

## Sub-features

- `mcps-rows` — the tab lists Add a server, *Your servers* and *From plugins*, each row its name over
  its health, at phone and tablet widths (`mcps`).
- `mcps-gate` — a bot whose plugin doesn't advertise `mcps` has no MCP tab (its URL lands back on
  General), and features offered apart are offered apart (`mcps-gate`).
- `mcps-toggle` — a switch flips a server off and back on, and the row's health follows (`mcps`).
- `mcps-remove` — Remove is offered in a server's Config tab only for the bot's own config's servers,
  asks first, and leaves the list showing what is left (`mcps-remove`).
- `mcps-catalogue` — Add a server opens Hermes's Catalogue with only the entries this bot doesn't
  have; a search narrows it (`mcps-catalogue`).
- `mcps-add` — an entry that declares values opens its form (required starred, secret masked, a
  default pinned); a refused add leaves nothing half-added (`mcps-add`).
- `mcps-custom` — a custom server is typed in by hand and its values land in the profile's `.env`
  (`mcps-custom`).
- `mcps-sheet` — one server's sheet: Config is the block read and written whole with one Save; Tools
  lists the schema cache, with Load tools probing that server (`mcps-server`).
- `mcps-access` — a waiting server's health line starts Server access, shows the Host's URL, and
  takes the pasted callback (`mcps-access`).

## How to get to it (user POV)

- Settings → a Bot → the **MCP** tab: `/settings/bots/<botId>/mcps` (each tab is its own history
  entry; back returns to General).
- `Add a server` at the top of the tab; a row's switch; a row itself opening the server's sheet.
- The health line of a row waiting on Server access.

## Driving it with the e2e flows

Preconditions:

- Baseline state (features/README.md). The mock's plugin advertises the `mcps` features; its rows
  are `github` (78 tools), `postgres` (Off), `linear` (Connecting…), `sentry` (its own failure
  text), `notion` (waiting on access) and `filesystem` (4 tools).
- The flows run at phone (390) and tablet (1024) widths, light and dark, where the journey claims
  them.

- **Rows and health.** Open the tab. Run `pnpm e2e mcps --shots "$GOTS_VERIFY_ARTIFACTS/<run-id>"`
  (from `app/`). The panel (`[data-mcp-tab]`) shows `Add a server` on top, then the two headings with
  the right servers under each; every row reads `name` over its exact health line (e.g.
  `github` / `Healthy: 78 tools`) and wears no badge.
- **Toggle.** Flip a server's switch off and back on. The same flow: the write lands on the Host and
  the row's health follows — read back from the Host, not only from the switch.
- **Gating.** Run `pnpm e2e mcps-gate`. A bot whose plugin answers without `mcps` has no MCP tab and
  its URL returns to General; a plugin listing servers without `mcps_write` shows no switches. No
  console error either way (the flow collects them and fails on any).
- **Remove.** Run `pnpm e2e mcps-remove`. Remove lives in the Config tab of a server the bot's own
  config holds, and on none a plugin provides; a cancel sends nothing; a confirmed removal takes the
  server away and the list shows what is left.
- **Catalogue.** Run `pnpm e2e mcps-catalogue`. Add a server → Catalogue lists only entries the bot
  doesn't have (no `Added` badge); search narrows by name and by Hermes's own description; a tap adds
  an entry that declares nothing to fill.
- **Declared values.** Run `pnpm e2e mcps-add`. The form titles each value by its name, subtitles it
  by its prompt, stars required ones, masks secrets, pins a manifest default, shows `Set` for a value
  the bot holds empty, and refuses the add until required values are given.
- **Custom server.** Run `pnpm e2e mcps-custom`. Name plus one transport (address, or command and
  arguments); the values the user gives land in the profile's `.env` and `${NAME}` in the block —
  verify the stored block and the `.env` line, not only the row.
- **One server's sheet.** Run `pnpm e2e mcps-server`. Config shows the block with one Save for the
  whole block; Tools lists the schema cache and Load tools probes just that server.
- **Server access.** Run `pnpm e2e mcps-access`. The health line of the waiting row is the tap; the
  sheet shows the Host's URL read-only and keeps waiting, refuses an address that isn't the flow's
  own, and the pasted callback clears the row by itself.
- **Proof of a whole pass.** `mcps-*.png` at every width and mode the journey claims, and the mock's
  state read back (`GET /api/plugins/memento/mcp`) where a write is part of the claim.

## Gotchas

- The tab exists only where the plugin's `info` advertises `mcps`; a bot whose Hermes is too old
  lands back on General. Don't read a missing tab as a bug in the tab.
- Each control is gated on its own feature (`mcps_write`, `mcps_remove`, `mcps_catalogue`,
  `mcps_add`, `mcps_access`, `mcps_config`, `mcps_tools`): a host may offer one without another, so
  assert the control's own gate, not the tab's.
- `get_mcp_status` reports `0` for a server never spawned, which is *not* a tool count: `Healthy`
  with no count is correct there.
- The mock holds removed servers aside (`mcpRemoved`); `POST /__mock/mcp` with the mock's key puts
  them all back. Do this between runs of the same journey — and never mid-journey.
- The mock's servers and its Catalogue are process state: on a shared instance a removal one flow
  made is visible to the next. With `--jobs`, each lane's mock is its own, so lanes never see each
  other's mutations.
- A value typed into a form never comes back on screen. The proof of a stored value is the server's
  block and the profile's `.env`, read after the write.

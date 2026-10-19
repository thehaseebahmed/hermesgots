# An MCP server's row says how it is doing, and an entry with nothing to fill is one tap

A bot's MCP servers were shown with a badge for each of six state words — on, off, connecting,
failed, needs access, provided by a plugin — and Server access was a separate button. A badge is a
word off a list the user has to learn, and it says nothing about the thing they actually want to
know. So a row is now its name over its health, in prose: *Healthy: 78 tools*, *Off*,
*Connecting…*, the Host's own failure text, or *Needs Authentication: Click here to authenticate* —
and that last line is itself the tap that starts the flow, so the waiting row and the way out of it
are the same words. A failure the Host says Server access can fix keeps its reason as the line and
that line stays the tap: a grant that failed leaves the failure on screen and the way back into the
flow on it, which is what the separate button used to be for.

The tool count is Hermes's own (`tools.mcp_tool_discovery.get_mcp_status`), which reports it only for
a server connected or registered in the process; it reports `0` for a server configured but never
spawned, and printing that would be a count the Host doesn't have, so a row without one says
*Healthy* alone and the plugin answers the count only where it knows it.

The list moved onto the Bot's own settings as one of three tabs — General, Models, MCP, each with its
own URL — because the servers are a property of that bot and the editor's one scrolling column had
grown a row that opened a second screen. Add a server sits on top, the bot's own servers follow under
*Your servers*, and the ones a Hermes plugin provides under *From plugins*: a heading with nothing
under it is dropped, so a bot with no servers shows the Add action alone.

The same reasoning runs through adding. The Catalogue answers entries, and the plugin's catalogue
read now carries what each entry declares, so an entry with nothing to fill — no env values, no
OAuth — is added by the tap that picks it, and the sheet closes behind it. One that declares values
opens its form, as before, and an OAuth entry also adds on the tap: nothing is written before Hermes's
own validator has passed it, and an add's answer is the Host's list of servers, so a one-tap add can
only land a server the bot then has. A server the user types in by hand takes the same write path
(validate → `_save_mcp_server` → reconcile) but the plugin builds the block, because a custom
server's values follow the Catalogue's rule rather than Hermes's own custom-add write: a secret goes
to the profile's `.env` and the block holds `${NAME}`, so `config.yaml` never holds a credential.

## A server's own sheet

The row is a summary, so what one server holds is its own sheet: **Config**, the block itself, and
**Tools**, what it offers. Neither is a screen of its own — neither is worth a URL, and both are
about the one server whose row was tapped.

Config reads the block back (`GET mcp/<name>`) and writes it whole (`POST mcp/<name>/config`): the
transport and its fields, then one field per environment value. A field is titled with the name the
value lands under on the Host and subtitled with the prompt its manifest writes for people — the
manifest's words are the explanation, the name is the thing being set, and a form that puts the
prose first makes the user hunt for what they are filling in. A value the bot already holds stands
empty with *Set* as its placeholder: the Host answers only *whether* it holds one and never its
content, so typing over it is what replaces it and leaving it alone sends nothing. One Save writes
the block once, enabled when something changed, because a write per keystroke would be a rewrite and
a reconcile per character. Arguments are one line in the form and reach the Host as argv, split the
way a shell splits them, so a path with a space survives.

Tools reads Hermes's schema cache, which connects nothing, so opening the sheet never starts a
server. *Load tools* asks the Host to connect that one server, list what it offers and disconnect —
which is why it is a tap rather than what opening the sheet does.

A server a Hermes plugin provides has a Config that is read and not written: no Save, no Remove.

## Consequences

- A one-tap add can still be refused — a duplicate name, a name a Hermes plugin provides, a command
  Hermes treats as suspicious — and a refusal shows the Host's own sentence as a toast, with nothing
  half-added.
- `needs_access` outranks a failure, as it did before: a row waiting on Server access reads that, not
  the auth error underneath it, because the tap is what the user can act on.
- The Catalogue hides what the bot already has instead of marking it, so the *Added* badge and the
  plugin's `installed` mark stop being screen furniture; the app filters, since what can be added is
  a presentation of the Host's full answer.
- The three tabs (General, Models, MCP) each have their own URL, the MCP tab exists only where the
  plugin advertises `mcps`, and a bot that can't list its servers lands on General instead.
- Two more features gate the sheet: `mcps_config` and `mcps_tools`, so a Host that can't describe a
  block or list tools offers no tab for it rather than an empty one.
- Custom add is offered where `mcps_add` is, independently of `mcps_catalogue`: a Host that can write
  a server but not browse Hermes's Catalogue still lets the user type one in.

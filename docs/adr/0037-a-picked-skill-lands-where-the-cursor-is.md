# A picked skill lands where the cursor is

*Supersedes in part [ADR 0008](./0008-the-slash-menu-opens-on-any-token-and-hoists-the-skill.md):
the hoist is gone. A picked skill is inserted where the cursor is, like every other edit in the
composer. Everything 0008 records about the menu opening on any token, the ranking and the cached
list stands.*

ADR 0008 hoisted a picked skill to the front of the message "because a skill runs only from
there". That rule is real — on the surfaces where a leading `/name` is expanded into the skill's
prompt by the host: Hermes's messaging gateway, its CLI, its session-control RPC. Gots never sends
through any of them. The composer's message goes to `POST /v1/runs` (or `/chat/completions` for a
host without it), and that door passes the last input item's content to the agent verbatim —
`_run_user_message` in Hermes's `gateway/platforms/api_server_runs.py` — with no slash parsing
anywhere on it. A `/name` at the front was never expanded for this app either: the
hoist changed the order of the words the model read, not whether a skill ran. The position the
composer was guaranteeing was one this app's transport never asked for.

So a pick is now an edit at the cursor. `/name` replaces what was typed of the token up to the
caret, and everything after the caret stays where it was — including the word the token was typed
into: with the caret before `tests`, typing `/gri` and picking `log-triage` gives
`fix the /log-triage tests`, where the old replacement ate `tests` by scanning forward from the
caret to the next whitespace. A space follows the name unless one already sits there, so the end of
a message gets one to keep typing with and an existing separator is not doubled.

`/steer` and `/queue` still replace the whole token. They are not sent as text — the app itself
reads them off the front of the message (`sendMode`) — so they must stay there, and the menu only
offers one when nothing but whitespace surrounds its token, so nothing of the user's can sit inside
the replaced range. `new` and `settings` run at once and never touch the text.

## Considered options

- **Keeping the hoist for skills.** Rejected: the constraint it served does not exist on the door
  this app uses, so the hoist only reorders the user's own words. A comment asking future readers
  to trust a host behaviour this transport never had is how the bug survived its own ADR.
- **One rule for every pick**, send-modes included. Rejected: a send-mode picked with the cursor
  mid-word would leave the token's tail as the text it carries — `/steer` with `eer` steered — and
  the menu's own guarantee (offered only when alone) is what makes whole-token replacement safe.
- **Dropping the characters after the cursor inside the token.** Rejected: that is the forward
  scan again — the token's far side can be the user's own word, and telling the two apart is the
  judgment the old code got wrong. Everything the cursor doesn't sit on stays.
- **Hoisting on send, inserting at the cursor in the composer.** Rejected: the message would leave
  the composer looking different from the one sent, and for no host behaviour this transport has.

## Consequences

- The message leaves the composer in the order it was written, wherever the skill's name sits in
  it. Nothing on the wire changed: the name was always literal text to the host, and what the agent
  does with it is the model's reading of the message, not the transport's.
- The pure rule behind the pick (`pickItem` / `pickSendMode` in `src/lib/slash.ts`) carries the
  text, the caret and the spacing, so `scripts/test-slash.mjs` pins it without a browser;
  `pnpm e2e slash-skills` pins the composer landing the caret after the insert.
- `hoistItem` is gone; `pickItem` and `pickSendMode` are the two picks it was split into.

# A bot's page is what the bot is, then its settings

**Amended by [ADR 0143](0143-a-bots-page-asks-its-host-nothing-it-does-not-already-read.md)**: the
_Test connection_ row is gone, and a _Plugin_ row at the foot of the bot's own card reports the version
the bot's host runs — read from the `info` answer the page already makes for its gates, and written to
the profile only from an answer this page took from the host.

Settings > Bot was a page of pages: a card of links, General first and the rest under it. Which left
the bot itself — the switch that turns it off, its notifications, its name, its picture, whether its
server answers — either on one of those pages or nowhere a thumb could reach in one tap. The bot is
not a setting _inside_ Settings > Bot; it is what Settings > Bot is about, and a list of links can't
lead with the subject of its own menu entry.

**The bot's own rows lead.** One card holds them, in three parts. Its switches come first — _Enabled_,
where the bot is linked, _Mute notifications_, and _Test connection_, whose whole row is the test and
which sits under the mute because that is the setting it proves. Then the caption _Bot Profile_ over
the name, the image and _Progress updates_; then _Hermes_ over where this bot's server is and the key
it answers with, drawn only while the bot is unlinked (the subagent model it once held moved to the
Delegation page, ADR 0109). These are the rows the old General page held, drawn exactly as they were drawn there — the same
switches acting in place, the same values opening their edits, the same edits at
`/settings/bots/<id>/bot/<edit>` (ADR 0055).

**Every setting page follows, in one card under _Settings_** — General, Models, Coding, Speech-to-text,
MCP, Skills — each still a row with an icon and a line saying what it holds, each still its own
address and its own history entry. One card rather than a card a page: the pages are the same kind of
thing, and a reader scanning for "where is the speech model" is scanning one list, not six sections.

**Two captions, and the rule behind them is ADR 0063's.** A caption names what a group of rows is
_about_, and here the two groups differ in exactly that: one is the bot, the other is the settings
behind it. This is the third page to carry captions and the first where the split is between subjects
rather than sections of one subject; the eligibility rule — a page whose groups say what things do,
not who owns them — is what it satisfies, and `AGENTS.md` is where that rule is written.

**Nothing is hidden to make the page shorter.** The bot's rows come first because they are asked for
first, not because anything was cut: the page is longer than the list it replaces by three cards, and
that is the cost of a menu entry that opens onto its subject.

**Why the shape is borrowed rather than invented.** Apple's Settings puts the account's own name and
picture above the list of everything else; Android's app-info screens lead with the app, then what it
may do. Both are the same answer to the same question — a settings entry about a _thing_ opens onto
the thing. This app already had that shape within a page (a page's own controls before its rows, ADR
0055); it now has it at the page's own top.

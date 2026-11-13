# A bot is named in a list by its own name, and its host only against a namesake

**Supersedes [ADR 0148](0148-a-bot-is-named-in-a-list-by-the-host-it-lives-on.md)** in what it calls a
bot, and **amends** its consequence that Settings' Name field still edits the name a list reads: the
field is gone. What 0148 built — the host ladder, one peer set, one rule every screen reads — stands.

Every host seals its default profile **Hermes** (`plugin/link.py`), so 0148 named a bot in a list by
the host it answers at rather than by the name that host gave it. That made every row an address:
`hermes`, `domain`, `domain/work`. Haseeb asked on 2026-11-12 for the opposite: the name first, an
address only where a name is not enough, alphabetical order wherever a list offers no sort of its own,
and no Name field in a bot's settings — the app cannot name a bot, so a field that writes this device's
copy of a name no host reads is a promise it cannot keep.

**So a list reads a bot's own name, and draws the host beside it only where another bot of that name
answers at a different host**: `Hermes (domain)` and `Hermes (example)` for two hosts' sealed defaults,
`Studio` for a name nobody shares, and two bots of one name on one host drawn bare, since no host tells
those two apart. The suffix is 0148's ladder unchanged, measured against the namesakes alone. Names are
compared case-blind and numerically, as every list in the app compares them (`lib/compare.ts`), and one
comparator — `byBotLabel` — orders every list, so no screen invents its own. The name is what the link
wrote when the device linked the host; nothing in the app writes another.

## Considered options

- **Drawing the host as a second element beside the name.** Every surface that holds a label holds a
  string — a chip, an aria-label, the sentence naming the bots a delete takes with it — so those
  surfaces would have had no host at all.
- **Keeping 0148's host-first naming and sorting it.** It answers neither half of the request: a name
  nobody shares still reads as an address, and two hosts' sealed defaults are still the only rows.
- **Adding a sort control to every list.** The request says alphabetical where there is no control;
  a control per list is a choice nobody asked to make four screens deep.
- **Keeping the Name row as a read-only label.** It would spend a row of the card saying what the
  page's title already says, and the profile's own name is not a setting the app can honour.
- **A refresh that carries a host's rename onto this device's row.** The link writes a name once and
  pulls only the fields the host does not own (`registry-fields.ts`), so a renamed bot keeps its
  link-time name until the host is linked again. Not now: it needs the pull to own a field it does not,
  and the flows set a bot's name themselves.

## Consequences

- A device whose bots are all called `Hermes` reads `Hermes (domain)`, `Hermes (example)`: longer than
  the host alone was, and a picker's row truncates at its width.
- A name nobody shares is short: `Studio`, not `studio.domain.com`.
- Two bots of one name on one host are two rows reading alike; the sidebar tells them apart by what
  each holds, not by its name.
- A bot renamed on its host keeps the name it was linked under. Correcting it means linking again.
- A bot's settings draw its name in the page's title and offer no row that writes one: the General
  card's Name row and the `name` edit page it pushed are gone, and push notifications keep reading the
  name the link stored.

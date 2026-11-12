# A bot is named in a list by the host it lives on

Every Hermes host seals its default profile as **Hermes** (`plugin/link.py`), so a device with three
hosts linked held three bots called "Hermes" — and every list of them, the chat's picker, New
project's, the room's seats, Settings' menu, the sidebar, the network log's pills, drew rows nothing
told apart. The name was never the device's to choose: it is the host's, and a user who renamed one
bot on one host only moved the confusion. Haseeb asked on 2026-11-12 for bots to be identified and
split per host, `hermes.domain.com` read as `hermes`, and as `domain` and `example` where two hosts
share that short name.

**So a bot's name in a list is read off the host it answers at, and never stored**: its first DNS label,
the domain part where another linked host wears the same one, the Hermes profile appended where one host
serves several bots, and the bot's own name only where nothing of its address tells it apart — two bots
linked at one host and one profile, or a bot with no server at all. `lib/bot-name.ts` is the one rule;
every screen that lists bots reads it, so no two lists can name one bot two ways, and the sidebar's
"Name" sort sorts by what its rows say.

## Considered options

- **Writing the name onto the profile when it is linked.** It needs a migration, goes stale the moment a
  host moves or a key is re-minted, and sync would carry one device's guess to the others: a renamed
  host would leave every device reading the old name until each one re-linked.
- **Renaming the bot on the host.** The default profile's name is the host's own word for it, used by
  Hermes itself, and a user linking a second host would have to rename it there before the list read
  sensibly.
- **Grouping the rows under host headings.** The label already splits the rows, and on a phone a heading
  restates the title above it.
- **The whole address as the name.** `hermes.domain.com` is longer than a pill, a row and a chip have
  room for, and the short name is what a person says.

## Consequences

- A bot's label changes when its address does, and reads the same on every device without a write.
- Two hosts behind one short name read as their domain parts, which is longer; a third host behind the
  same parts reads as its whole host.
- A host serving several profiles reads `hermes` and `hermes/work`, where the bare name would have said
  "Hermes" twice.
- Settings' Name field still edits the name the host sealed — it is that bot's own name on its host, and
  what push notifications say. A list no longer reads it.

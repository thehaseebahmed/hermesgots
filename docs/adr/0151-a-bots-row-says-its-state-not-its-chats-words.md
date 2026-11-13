# A bot's row says its state, not its newest chat's words

The sidebar's bot row draws two lines: the bot's name with its age, and under it what the newest chat
last said. Only a bot that had never said anything showed whether its host was checking in — so the
one fact a reader can act on without opening the bot was the fact almost no row carried, since a bot
that has ever spoken hid it behind its own words. And "there is something new here" was drawn twice in
the same row, as a dot on the avatar's corner and as a count in a pill, with nothing saying what either
counted.

**The line under the name is the bot's state, and it is never empty.** Something unread first:
`3 unread`, counted in conversations — its chats, the rooms its roster seats, and its routine runs —
because that is what the list behind the row draws, and one row of it is one. With nothing unread the
line says `Online` while the bot's host keeps checking in, `Offline` once it goes stale, and, where
this device cannot answer for the host at all, what is missing instead of falling silent: `Not seen
yet` for a linked host nothing has answered from, and `Not linked` for a bot no host registered. Those
are the words the rest of the app already uses — Settings' Enabled row says `Not seen yet`, and its
last row is `Link a bot` — so one vocabulary covers every screen, and neither is `Offline`, because a
bot this device cannot place is not a bot it has watched go quiet. A row with no second line read as
one that had failed to load, which is why the silence the first draft of this record kept was given
up. The newest chat's words are no longer the subtitle's, and the sidebar no longer reads them: that
was one extra read per bot on every pass, and the bot's own list says the same thing one tap away.

**The mark is the warning dot, and there is one of it.** A dot sits at the right end of the row while
something is unread, in `{colors.warning}` — the tone the app already carries for a thing waiting on
the reader, and a fill, never a line of text. It carries a faint halo of its own tone, the one glow in
the app outside a pop-up's shadow: on a row that tints under the reader's finger, a bare fill at this
size reads as a speck. It is drawn and never read out, because the count beside it is what says the
state. The waiting pill goes, because the row is allowed one mark and the user chose the count: what
it said is still on the bot's list, where a row says it needs the reader. The count is not a
replacement for it — the count is mark-based, so a chat this device has already read can still hold a
reply waiting on the user and not be counted — and the chip was the better words for that fact; it
went for the row's sake, not because the count covers it. The avatar's corner dot stays for the rail
alone, in `{colors.info}` like every other unread dot in the app: a collapsed sidebar draws no line
under the name, so that is the only place it has to be, and a dot with no words beside it is the app's
existing mark rather than the toned one this row adds.

## Considered options

- **Keep the preview and put the state beside it.** Rejected: a row has no third line, so the state
  would replace the preview on some bots and never be seen on others — which is what "the row prefers
  what the chat last said" already meant, and what this record replaces.
- **Say nothing where the device cannot place the host.** Rejected by the user: a row whose second
  line is empty reads as a row that failed to load, and the two bots it applies to — linked but never
  answered, and added by hand — are the ones a reader most needs a word about.
- **`{colors.destructive}` for the dot.** Rejected: an unread row is waiting on the reader, not
  broken, and the app's red is a button tone rather than a state.
- **A number inside the dot.** Rejected: a dot carries no words, and a number set in 8px is not
  readable.
- **Counting unread messages instead of conversations.** Rejected: a chat that said forty things is
  still one row left to read.

## Consequences

- `stateLine` (`lib/bot-chrome.ts`) holds the words, and `scripts/test-bot-chrome.mjs` pins every state
  as one table, including the two that used to be silence. `previewLine`, and the `preview` read
  behind it, are gone. `stateLine` reads `presence` itself, so the words and the facts cannot drift
  apart, and it answers a string rather than `string | undefined`.
- `presence` answers `undefined` where a pass got no answer from a host this device has never heard:
  before this, it answered "away", so the row would have said `Offline` about a bot the device cannot
  place at all, while Settings said nothing about the same bot. Only a sighting lets a failed pass read
  as away (ADR 0110's rule for the dot is unchanged).
- `BotSummary.unread` is a count. `useBotSummaries` asks `useRoomNeeds` for the seats, so a room is
  counted where it lists (ADR 0115), and that costs the read of each room's page where the summary
  used to read each bot's newest chat.
- `DESIGN.md` gains `warning-dot`, and the state-dot rule names `{colors.warning}`.
- The collapsed rail keeps the `info` dot with its `sr-only` "New activity"; the open sidebar's mark is
  `data-unread` on the subtitle's dot, which is what `scripts/test-bot-rows.tsx` reads.
- ADR 0110's rule is unchanged: a chat this device never opened holds no read mark, so it is not
  unread and does not count.

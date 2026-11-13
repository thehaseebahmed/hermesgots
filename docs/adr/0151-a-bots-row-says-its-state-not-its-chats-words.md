# A bot's row says its state, not its newest chat's words

The sidebar's bot row draws two lines: the bot's name with its age, and under it what the newest chat
last said. Only a bot that had never said anything showed whether its host was checking in — so the
one fact a reader can act on without opening the bot was the fact almost no row carried, since a bot
that has ever spoken hid it behind its own words. And "there is something new here" was drawn twice in
the same row, as a dot on the avatar's corner and as a count in a pill, with nothing saying what either
counted.

**The line under the name is the bot's state.** Something unread first: `3 unread`, counted in
conversations — its chats, the rooms its roster seats, and its routine runs — because that is what the
list behind the row draws, and one row of it is one. With nothing unread the line says `Online` while
the bot's host keeps checking in, `Offline` once it goes stale, and nothing at all where this device
cannot tell: a bot with no host, turned off, or never heard from is unknown rather than away, which is
`presence`'s own rule and the silence Settings keeps about the same bot. The newest chat's words are
no longer the subtitle's, and the sidebar no longer reads them: that was one extra read per bot on
every pass, and the bot's own list says the same thing one tap away.

**The mark is the warning dot, and there is one of it.** A dot sits at the right end of the row while
something is unread, in `{colors.warning}` — the tone the app already carries for a thing waiting on
the reader, and a fill, never a line of text. It is drawn and never read out, because the count beside
it is what says the state. The waiting pill goes: a reply that waits on the user is activity past the
read mark, so the count already includes it. The avatar's corner dot stays for the rail alone — a
collapsed sidebar draws no line under the name, so that is the only place it has to be.

## Considered options

- **Keep the preview and put the state beside it.** Rejected: a row has no third line, so the state
  would replace the preview on some bots and never be seen on others — which is what "the row prefers
  what the chat last said" already meant, and what this record replaces.
- **`{colors.destructive}` for the dot.** Rejected: an unread row is waiting on the reader, not
  broken, and the app's red is a button tone rather than a state.
- **A number inside the dot.** Rejected: a dot carries no words, and a number set in 8px is not
  readable.
- **Counting unread messages instead of conversations.** Rejected: a chat that said forty things is
  still one row left to read.

## Consequences

- `stateLine` (`lib/bot-chrome.ts`) holds the words, and `scripts/test-bot-chrome.mjs` pins all four
  states as one table. `previewLine`, and the `preview` read behind it, are gone.
- `BotSummary.unread` is a count. `useBotSummaries` asks `useRoomNeeds` for the seats, so a room is
  counted where it lists (ADR 0115), and that costs the read of each room's page where the summary
  used to read each bot's newest chat.
- `DESIGN.md` gains `warning-dot`, and the state-dot rule names `{colors.warning}`.
- The collapsed rail keeps the `info` dot with its `sr-only` "New activity"; the open sidebar's mark is
  `data-unread` on the subtitle's dot, which is what `scripts/test-bot-rows.tsx` reads.
- ADR 0110's rule is unchanged: a chat this device never opened holds no read mark, so it is not
  unread and does not count.

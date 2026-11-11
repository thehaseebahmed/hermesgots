# A bot's routines are its own screen

Routines had one screen at `/routines`, the sidebar's own row beside Projects, Code, Meetings and
Canvas, listing every bot's jobs and runs in one page — one bot's card after another's, folded away as
the reader left them. That is a screen for a fleet. A routine, though, is a job a bot's own host runs
on a schedule: its id lives in that profile's cron store, its runs are that host's transcript, and the
bot it belongs to is the only bot that can answer for it. A reader looking at a bot wants that bot's
routines, and a list of them across everything is a place they have to pick one out of.

**So a bot's routines are a screen under the bot.** `/b/:profileId/routines` draws that bot's jobs and
their runs, in the same groups — and with the same controls to pause, resume, run and refresh — the
page drew before. It is opened by the routine icon in the bot's chat list header, beside the search
toggle, which is the one control in that header that opens something other than a chat (ADR 0136).
Below the width where the list stands beside it, the page's back returns to the bot's list; at that
width the list is already there and the page has nothing to lead back to.

**The sidebar's row goes, and the root address lands somewhere sensible.** Routines leaves the
sidebar's own rows, because a bot's routines are reached from the bot. `/routines` was a bookmark on
some devices and a deep link in `pnpm e2e screens`; it redirects to the active bot's routines, and to
`/` where there is no active bot. One screen, one address, and an old address that still works.

**A run's bar opens the run.** The page's runs each open the run's own read-only screen, through the
same reader a routine's row opens (`runRowOf` in `lib/cron.ts`, `components/chat/routine-chat.tsx`) —
so a delivery older than any row this device holds is still readable from the page, and a run whose row
the reader deleted is still a run on the host.

## Considered options

- **Keeping `/routines` as a cross-bot page beside the bot's own.** Two screens for one thing, and the
  two kept in step forever.
- **A routines tab in the bot's settings.** They are not settings: nothing about a routine is the bot's
  configuration, and settings is where a reader goes to change something.
- **The routine icon opening a sheet over the list.** A sheet is a look at something inside a screen,
  and this page is a screen with a run's address behind it.
- **Keeping the sidebar row as a shortcut to the active bot's routines.** A row that means "the bot
  above it" is a second way to reach a bot's own screen.

## Consequences

- A bot with no host, or a host whose plugin predates the routines routes, shows what it showed before:
  the install block, or the host's own error.
- The routine icon is one more control in the list header; a device without the pane beside it reaches
  the page from the bot's list, which is where it starts and where back returns it.
- `pnpm e2e screens` visits Routines at the bot-scoped address, and the flow's audit row in
  `docs/e2e-flow-audit.md` names it.
- A reader with no bot selected has no routines anywhere: `/routines` sends them home, where the bots
  are.

# A routine's delivery is a marker in Main

[ADR 0137](0137-a-routines-delivery-is-a-chat.md) made each delivered run a row of its bot's chat list,
and set `GOTS_HOME_CHANNEL` in every profile's `.env` so a bare `deliver: gots` resolved. A row among
the chats read as a conversation the reader could answer, and the variable wrote another program's
configuration to make a name legal.

**The run is a marker in the bot's Main.** The delivery still publishes the one record per run, keyed by
the job and the execution, and now stamps how long the run took (`durationMs`, from the execution
ledger). The record is no row of any list (`isListed` is false for it): the bot's **Main** draws it as
one centred line, `Routine "<name>" ran for X min Y secs`, among its messages by time. It is not a
message and is in no transcript, so the bot never reads it. Tapping it opens the run's transcript
read-only, and that screen leads back to Main.

**The channel is `gots:main`, and nothing is configured.** Hermes resolves an explicit `platform:target`
without a home channel, so a new routine is given `gots:main` (the system-prompt section says so, and
`fill_deliver` writes it when the model omitted `deliver`). Nothing is written to a `.env` and no
variable is read; `cron_deliver_env_var` stays in the registration only because Hermes needs it to
know the platform. Every stored `gots…` ref still delivers, since the ref is ignored.

**The alert opens Main.** A non-silent delivery sends the existing push, and a tap on it opens the bot's
Main. The marker lights Main's unread: the bot row's count and Main's own read mark both take the
newest marker's time as Main's activity.

## Considered options

- **A table and route for markers.** Rejected: the per-run record is already synced, deduplicated and
  tombstoned, so a second store would hold the same fact.
- **Writing the routine's words into Main.** Rejected for the reason ADR 0081 was superseded: a thing
  that looks like the conversation but is not is worse than none.

## Consequences

- A bot's chat lists, their counts and the Routines pill are gone; the routines screen is unchanged.
- A routine record cannot be pinned, archived or listed; it can still be opened by its address.
- A run the ledger cannot time reads `Routine "<name>" ran`.

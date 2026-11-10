# Interfaces are off until someone turns them on

The Interfaces switch (ADR 0033) read as on unless a stored off said otherwise, so a host that had
never been asked was told the component library in every new chat and its replies were drawn as
cards and charts. The library does not yet draw well enough to be the default. **A host with no
stored value now reads as off; only an explicit on is stored, and only an on tells the next chat the
library.**

The switch, its route and the section the plugin withholds are unchanged. What moved is which side of
"no row" the default sits on, and with it the failure mode: a store the plugin cannot read used to
leave the library on so a host that could not answer never took it away, and now leaves it off, for
the same reason read the other way round. The library is opt-in, so a host that cannot answer must
not tell it to a chat that did not ask.

The app's own fallback is untouched. `UNANSWERED_IS_ON` only decides how a block already in a thread
draws while the host is not answering, and a block exists only where a model was told the library, so
drawing it is right and flashing raw code over a card on every dropped connection is not.

## Considered and rejected

- **Keep hosts where someone chose on.** An on was never stored, because the default was on, so a
  migration cannot tell a deliberate choice from a host that was never asked. It could only guess,
  and a guess would carry the old default forward for exactly the hosts this change is for.
- **Hide the switch until the library is ready.** Nobody could then try it, and trying it is the
  reason to keep it behind a switch instead of removing it.

## Consequences

- **A host where Interfaces was on loses it** until the user turns it back on, which is one tap and
  is stored from then on.
- **An open chat keeps the prompt it started with** (ADR 0033), so chats begun before the update keep
  being told the library and chats begun after it are not, until the switch changes.
- **A block a model emits anyway draws as the code it came from**, which is the off behaviour ADR 0033
  already defines.

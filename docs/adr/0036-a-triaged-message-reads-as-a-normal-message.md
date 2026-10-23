# A triaged message reads as a normal message

A message the host is deciding on wears no cue of its own: no dimmed bubble, no line under it, so it reads as any message the user sent until the host answers — and then it becomes either that thread's card or its Moved marker, as ADR 0034 already draws them. The app's own state for it is `triaging`, which replaces the word the GLOSSARY has always asked us to avoid: the decision is the host's (ADR 0029) and the name now says so everywhere, so the persisted status was renamed under a Dexie upgrade rather than left to live under two names, the indexed field included.

Considered and rejected: keeping the dimmed bubble and a "Routing…" line, which made every message sent from Main read as not-through-yet for the seconds the host takes (and used the wrong word besides), and holding the message out of the thread until the host answered, which would show the user's own message arriving late, or never on a timeout.

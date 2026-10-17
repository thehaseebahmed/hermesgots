# A recovery code is compulsory; a passkey is optional

Sync's data key is wrapped by whatever can unwrap it, and the recovery code is the only wrapper that
isn't tied to one device's authenticator. A passkey can be lost with the hardware, and on a device
that never had one — Android has no passkeys at all — the code is the only way into an existing
vault. So setup always mints a recovery code, shows it as a wizard step of its own, and won't go on
until the user has copied it; a passkey is offered beside it as an extra way to unlock *this*
device, never as a replacement, and cancelling the platform prompt leaves the code untouched.

The alternative — passkey first, code only when the authenticator can't do it — reads better on a
phone with a fingerprint reader and is what Gots used to do, but it put the compulsory step behind a
browser prompt that can be cancelled, and left anyone who dismissed the code with no way back in.
Nothing reaches the server until the code step is confirmed: the new vault stays in memory while the
code is on screen, so closing the tab there leaves no vault wrapped by a code nobody saw, and the
passkey joins that same in-memory vault. Because the code is the recovery story rather than a
convenience, Settings can rotate it: a new wrapper is written and shown first, and the old one is
only dropped once the user confirms they've copied the new one, so a failed save can't leave an
account with no code at all.

Replacing it from Settings is one dialog doing both steps, asking for the code that can still open
the account and then showing the new one. That is the one place a form sits in a confirmation rather
than in a pop-up sheet.

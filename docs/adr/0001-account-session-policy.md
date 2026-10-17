# The Android account session ends only on Identity's word

Identity revokes a refresh token as it spends it, and the app can reach a refresh from more than one
call site in the same tick — two synced documents read side by side both trade the same token. The
second trade is answered with a rejected token, which used to be read as the end of the session: the
store was cleared and the sign-in gate appeared minutes after the screen went off, with a silent
GitHub round trip bringing the user straight back. So the app now trades one token at a time,
re-reads the store before believing a rejection, and keeps the session on anything that isn't
Identity's verdict about the stored token itself — a 5xx, a 429, a lost reply. The same reading
applies to the sync function, which answers 5xx rather than 401 when it couldn't check a Bearer
token, and to a failed check at load, which leaves the session standing on what the stored token
already names instead of showing the gate.

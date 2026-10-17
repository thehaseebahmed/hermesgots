# Gots

Gots is a client for one Hermes Agent server: chat with your bots from a phone, and watch the work they do on your behalf.

## Language

**Account session**:
Who you are to Gots. Signed out means it has ended, and only a fresh sign-in brings it back.
_Avoid_: login, account, user, "logged out"

**Identity**:
The sign-in service an account session lives in. The Android app talks to it directly; the browser goes through the library.
_Avoid_: auth server, login service, GoTrue

**Sign in with GitHub**:
The only way to get an account session. On Android it leaves the app and comes back through a Custom Tab.
_Avoid_: log in, authorise, connect account

**Vault**:
The key that encrypts what syncs. The server can only hold it wrapped by a passkey or a recovery code.
_Avoid_: sync key, master password, encryption account

**Sync**:
The encrypted copy of your bots, appearance switches and chat lists, kept for you on the server.
_Avoid_: backup, cloud, account data

**Recovery code**:
The code that unlocks sync on a device with no passkey; on Android, the only way in.
_Avoid_: backup code, recovery phrase, seed

**Sync locked**:
The account session is intact but this device holds no vault key, so sync stays off until it is unlocked (the step Gots shows as "Unlock sync").
_Avoid_: signed out, re-login, locked account

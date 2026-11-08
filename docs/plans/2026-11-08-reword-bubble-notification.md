# The Bubble's notification reads as Gots, ready to dictate

## Goals
- **G1** The ongoing notification's title is the app's name, Gots, taken from the app's own label rather than typed again in the service.
- **G2** Its text names the bot that hears the take: `<botname> is ready for AI dictation`.
- **G3** With no bot mirrored, or a mirrored bot whose name is blank, the text keeps today's `Choose a bot in Gots.`, so the notice never claims a bot is ready when none is named.

## Non-goals
- The notification channel's name and description (`Dictation Bubble`), declined by the user.
- The `Turn off` action label, and the Bubble's other messages (`NO_TYPING`, `SLOW`, and `NO_BOT`'s uses as a take's refusal).
- Moving the Bubble's copy into `strings.xml`, and translating it.

## Change map
| Layer | Status | Goals | Tested at |
|---|---|---|---|
| Android foreground-service notification (`BubbleService.notice`) | changed | G1 G2 G3 | `notice()` on a phone after `ACTION_START` |
| Notification channel (`BubbleService.channel`) | affected | — | Android's own notification settings for Gots |

## Flows
No flow crosses layers: `notice()` builds the copy from the mirrored bot's name and the app label each time it is posted, and `ACTION_REFRESH`/`announce()` re-post it whenever the phone is told about the bot. Nothing moves but the words.

## Steps
1. **The notice names the app and the bot.** Read the title from `R.string.app_name` and build the text as the mirrored bot's name plus `is ready for AI dictation`, keeping `Choose a bot in Gots.` where no bot is mirrored. Goals: G1 G2 G3. After: none. Layers: notification. Check: a `grep` for `setContentTitle(getString(R.string.app_name))` and for the `is ready for AI dictation` literal is red before and green after; the Kotlin compiles in the PR's Android job (`./gradlew lintDebug assembleDebug`), since this sandbox has no JDK or Android SDK.

   Done.

## Decisions
- **The title is read from `R.string.app_name`, not written as a literal.** Made by the agent: `AGENTS.md` records a rename (memento → gots) leaving copies of a name stale in files no gate reads, so a second "Gots" in the service is a drift risk; the value on screen is unchanged.
- **The subtitle stays composed in `notice()`.** Made by the agent: the file's other copy is inline, one reader builds the notice, and extracting it buys nothing yet (KISS).
- **The no-bot line is unchanged.** Made by the user (Q1). `NO_BOT` also refuses a take and is drawn on the Bubble, so rewording it for the shade would reword a refusal too.
- **The channel is left alone.** Made by the user (Q2). Its name is already learned in Android's settings, and the request named the notification.
- **No Kotlin unit test is added.** Made by the agent: CI runs `lintDebug` and `assembleDebug` and no unit-test task, and an assertion on `notice()` would need Robolectric, which the module does not depend on; the compile is CI's and the words are a phone's.

## Risks
- A long bot name ellipsises in the collapsed shade: the text is one line there.
- Nothing in this change proves the rendered notification. CI compiles it and the strings' source is checkable; only a device shows the shade.
- `NO_BOT` stays as it is, so a shade with no bot mirrored reads `Gots` / `Choose a bot in Gots.` — the title and the sentence name the app twice, which is what the user chose over claiming readiness.
- Android draws the app's own name above a notification's title, so most shades will read `Gots` twice in every state; that duplication is the title the user asked for.
- A mirrored bot with a blank name draws `NO_BOT` too, so the notice reads `Choose a bot in Gots.` while a bot is mirrored. That shape is carried over unchanged.
- The mirrored block's fingerprint (`app/src/lib/bubble.ts`) carries the bot's id, connection, vocabulary and wait, not its name, so renaming the bot does not re-post the notice: the shade keeps the old name until something else moves it.

## Not now
- Renaming the channel to match the notice, from the declined breadth item.
- Carrying the take's state (recording, uploading) in the notice's text, from the re-post path `announce()` already owns.
- A `tap to change` bot hint, or moving every Bubble string into `strings.xml`.
- Re-posting the notice when the mirrored bot is renamed: the fingerprint that decides a mirror omits the name, and that rule lives in the app's `bubble.ts`, outside this change.

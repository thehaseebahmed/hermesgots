# The Bubble's notification reads as Gots, ready to dictate

## Goals
- **G1** The ongoing notification's title is the app's name, Gots, taken from the app's own label rather than typed again in the service.
- **G2** Its text names the bot that hears the take: `<botname> is ready for AI dictation`.
- **G3** With no bot mirrored the text keeps today's `Choose a bot in Gots.`, so the notice never claims a bot is ready when none is.

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
No flow crosses layers: `notice()` builds the copy from the mirrored bot's name and the app label each time it is posted, and `ACTION_REFRESH`/`announce()` already re-post it when that bot changes. Nothing moves but the words.

## Steps
1. **The notice names the app and the bot.** Read the title from `R.string.app_name` and build the text as the mirrored bot's name plus `is ready for AI dictation`, keeping `Choose a bot in Gots.` where no bot is mirrored. Goals: G1 G2 G3. After: none. Layers: notification. Check: `grep` on `BubbleService.kt` for the two sentences is red before and green after; the Kotlin compiles in the PR's Android job (`./gradlew lintDebug assembleDebug`), since this sandbox has no JDK or Android SDK.

   Done.

## Decisions
- **The title is read from `R.string.app_name`, not written as a literal.** Made by the agent: `AGENTS.md` records a rename (memento → gots) leaving copies of a name stale in files no gate reads, so a second "Gots" in the service is a drift risk; the value on screen is unchanged.
- **The subtitle stays composed in `notice()`.** Made by the agent: the file's other copy is inline, one reader builds the notice, and extracting it buys nothing yet (KISS).
- **The no-bot line is unchanged.** Made by the user (Q1). `NO_BOT` also refuses a take and is drawn on the Bubble, so rewording it for the shade would reword a refusal too.
- **The channel is left alone.** Made by the user (Q2). Its name is already learned in Android's settings, and the request named the notification.
- **No Kotlin unit test is added.** Made by the agent: this sandbox has no JVM and CI runs no unit-test task, so a test here would prove nothing anywhere; the compile is CI's and the words are a phone's.

## Risks
- A long bot name ellipsises in the collapsed shade: the text is one line there.
- Nothing in this change proves the rendered notification. CI compiles it and the strings' source is checkable; only a device shows the shade.
- `NO_BOT` stays as it is, so a shade with no bot mirrored reads `Gots` / `Choose a bot in Gots.` — the title and the sentence name the app twice, which is what the user chose over claiming readiness.

## Not now
- Renaming the channel to match the notice, from the declined breadth item.
- Carrying the take's state (recording, uploading) in the notice's text, from the re-post path `announce()` already owns.
- A `tap to change` bot hint, or moving every Bubble string into `strings.xml`.

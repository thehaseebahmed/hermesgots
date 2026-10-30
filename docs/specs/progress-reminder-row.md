# A Developer switch shows the progress reminders a thread hides

Status: ready for a human to read. Design: [ADR 0068](../adr/0068-a-bots-progress-reminders-are-a-setting-not-a-prompt-line.md), amended in place. Its tickets are #690 and #691. These docs land in pull request #692, which closes the gate issue #693 — and #693 blocks the spec until that pull request merges.

## Problem Statement

A bot's progress reminders are invisible twice over. The host asks for one only after a stretch of silent tool calls, at the rate the bot's own level sets (Off, Quiet, Normal or Chatty — ADR 0068), and when it does, the note it writes to the model arrives in the transcript as the result of a call that never ran. The thread drops that card whole, and rightly: the note is the host talking to the model, and drawing it would hand a reader machinery in place of work. That is correct for a reader and useless to anyone testing the reminder, because the app's own hiding is the thing standing between the tester and the evidence. Whether a reminder fired, where in the run, and what it actually said can only be answered by reading a raw transcript on the host — which is exactly what someone with a phone in their hand cannot do.

## Solution

A Developer switch on the device: **Show progress reminders**, in Settings > Developer's first group, beside Bot threads and Meetings. Off, it is what the app is today. On, wherever a reminder's refusal would be dropped, the thread draws a row of its own: it stands at the point in the reply where the call was refused, outside the run's tool group and never counted among its calls, reads in the app's words rather than as failed work, and opens on a tap to the note exactly as the host wrote it, its pinned opening first. It reaches both chat screens, on a live run and on a chat read back from the host's transcript. Turning it on does not rewrite the thread already on screen — the next open shows what the chat holds. Nothing is written to a bot's host, no plugin change is needed, and nothing is stored that the transcript does not already carry.

## User Stories

1. As someone testing the reminder, I want a Developer switch that makes the note visible, so that I can see it fire without reading the host's transcript.
2. As someone testing, I want the row to stand where the call was refused, so that I can tell at which point in the run the bot was asked.
3. As someone testing, I want the row outside the run's tool group, so that the group still counts only the calls that ran.
4. As someone testing, I want to tap the row and read the note word for word, so that I know exactly what the model was told.
5. As someone testing, I want the row to survive a reload, so that a chat reopened later still shows what fired.
6. As someone testing, I want it on both chat screens, so that I can test whichever screen the build opens.
7. As someone testing, I want the switch remembered on my device, so that it stays on across restarts until I turn it off.
8. As someone reading a thread with the switch off, I want nothing new drawn, so that the app's own reading of a reply is untouched.
9. As someone who turns the switch on with a chat open, I want that thread not to jump, so that I keep my place — the next open shows the rows.
10. As someone reading the row, I want it named in the app's words rather than as a failed call, so that a reminder never reads as work that broke.
11. As someone reading the sheet, I want the note's own pinned opening to stay its first line, so that what I read is the host's text and not a paraphrase.
12. As a developer of the app, I want one rule both screens ask, so that the two screens cannot drift on what a reminder is.
13. As a reviewer, I want the switch to cost nothing when it is off, so that no read or render changes for anyone who never unlocks Developer.
14. As someone testing against the mock, I want the mock's own transcript rows to drive the same path, so that the feature is checkable without a real bot.
15. As someone testing on a real bot, I want the row to appear without waiting out a long run, so that Chatty's ten calls on a bot's own General page is enough to see one.
16. As a maintainer, I want the ADR and the glossary to name the exception, so that the next reader does not read "never drawn" as still absolute.

## Implementation Decisions

**One device setting.** A boolean in the device's own settings store, beside the other Developer switches, off by default and read wherever a thread is folded rather than pushed into a stream already running. It is a display choice of this device, so it is never written to a bot's host and never travels with the bot.

**The refusal rule stays one function.** The app already recognises a reminder by the note's pinned opening, which the plugin's own header pins and a test holds both sides to. What is new is the decision of what to draw once one is recognised, and that decision is taken from the same recognition — one rule asked by both chat screens, on both the live stream and a transcript read back from the host. Nothing re-parses the note's prose to tell it apart from any other hook's refusal.

**A reminder is a row of its own in the thread's model, not a tool call.** It carries the note and its position among the reply's parts, and it is never added to a run's group of calls nor counted in the group's total. It is drawn with the app's work-row look, titled in the app's words, and its sheet opens the note unmodified.

**The live path drops nothing it needs.** With the switch on, a refusal the stream reports becomes the row instead of being discarded; with it off, today's discard is unchanged, including the anchor the thinking row that followed a dropped call takes. A refusal with no matching running call still lands somewhere sensible rather than being lost.

**Read at fold time, not pushed.** Turning the switch on does not trigger a re-read or a rewrite of the thread on screen. Every open and every reload derives the row from the transcript the host still serves, so a chat holds its reminders without a byte of new storage, and turning the switch off returns the thread to today's rendering with no migration.

**No host, no plugin, no schema.** The note is already in the transcript; the level that decides how often one arrives stays the host's and per bot. Nothing about the four levels, their counts or the hook's behaviour changes.

## Testing Decisions

- **What a good test asserts here** is what a reader sees for a thread that holds a reminder's refusal: the row is there, it stands where the call was refused, the group beside it counts only calls that ran, and the sheet opens the note the host wrote. Not how the fold stores it, and not the note's prose read back.
- **Unit** — the new chat screen's reducer and the transcript fold, over the existing reminder fixture (a stored note shaped exactly as the plugin writes it): the row appears at the refused call's place with the switch on, the call is absent from its group's count, and with the switch off the row is absent and the group is as it was. Prior art: the chat-next reducer and fold tests, which already walk this fixture.
- **Component** — Settings > Developer draws the switch and writes the one setting; the current chat screen and the new chat screen each draw the row and open the same note over a seeded device; with the switch off neither draws anything. Prior art: the Settings component tests that drive the Developer switches, and the existing progress-reminder component test.
- **No new end-to-end flow**: the change is a derived row over one setting, which the component tier reaches; geometry is all a flow would add, and the row reuses a work row's own look (ADR 0019). A hands-on pass against the mock and one real bot at Chatty is what proves the plugin really fires.

## Out of Scope

- How often a reminder fires, the four levels, and every plugin behaviour behind them.
- Showing the note to a reader who has not unlocked Developer.
- Other hooks' refusals, which keep drawing the way they do today.
- A count, a level or a timestamp beside the row — the counts are the loop's business (ADR 0068).
- Rewriting the thread already on screen when the switch moves.
- Any e2e flow, screenshot baseline or Android-specific work.

## Further Notes

- ADR: [0068](../adr/0068-a-bots-progress-reminders-are-a-setting-not-a-prompt-line.md), amended in place rather than superseded, because the exception narrows one paragraph rather than reversing the decision.
- Glossary: **Progress reminder** in [GLOSSARY.md](../GLOSSARY.md) gains the developer exception.
- The row is deliberately a developer view of the host's machinery: that is why it is not a card in the reply's own vocabulary, and why it is not drawn beside a progress update the bot actually wrote.
- Testing on a real bot needs a level of at least Chatty to see a reminder without a long run; the switch changes what is drawn, never when.

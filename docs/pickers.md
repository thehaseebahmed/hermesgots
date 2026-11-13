# The pickers, and what a tap on one does

A pick is a control that opens a list and writes the one entry the reader chooses from it. This
page is the enumeration of every real single-choice surface in the app, the record of what a tap on
each does, and the settlement of the sites where applying the only entry without opening the sheet
would hide something the reader needs.

The rule is one function, `pickStep` in `app/src/lib/pick-one.ts`, and one trigger beside it,
`usePickOne` in `app/src/lib/use-pick-one.ts`. A tap asks the rule about the list the screen holds
at that moment, and the rule answers one of three things:

- **apply** the entry — a list that is settled and holds exactly one option, which is not already in
  force — through the same handler a row of the sheet calls, so the state left behind is the one a
  row's tap leaves;
- **quiet** — one option, and it is already the value the row shows; nothing is opened and nothing is
  written;
- **open** the sheet — every other state: the list is still reading, the read failed, the list holds
  nothing, or it holds two or more.

The rule is asked only from a tap, never from an effect, so a list that lands after the tap has no
path to an apply. A write in flight is marked before it starts and released when its own promise
settles, so one tap can never apply twice: a second tap while the write is out does nothing, and a
tap after it lands finds the option in force and is the quiet case. `modelsRead` (`app/src/lib/model-pick.ts`) is how a model surface says
which of the three states its list is in.

## The enumeration

One row per site. **Applied** means a tap on the site's row applies its lone entry itself; **settled**
means the site keeps opening, with the options recorded under *The settlement* below; **never 1**
means a fixed inventory that cannot hold exactly one; **no caller** means the surface is exported and
imported nowhere, so no tap reaches it; **not a sheet** means the list is the platform's own popup (a
`Select`), which the rule cannot skip and which still shows the value in force. `S8a`–`S8e` are five
call sites of one sheet, `ModelPick`.

| # | Site | Surface | Option source | Per-bot count | Also in the sheet | Verdict |
|---|---|---|---|---|---|---|
| S1 | `app/src/components/bot-settings.tsx` `picked()` — a General key the host declares choices for | `PickSurface` + `PickList` | the host's `block.fields[].options` | the host's list; can be 1 | the `restart` note, *Applies when this bot's Hermes restarts.* | **settled** |
| S2 | `app/src/components/bot-settings.tsx` Image | `PickSurface` + `PickList` | `BOTS` (`app/src/components/bots.tsx`) | fixed 8 | — | never 1 |
| S3 | `app/src/components/bot-llm-providers-tab.tsx` Transport | `PickSurface` + `PickList` | `TRANSPORTS` (`app/src/lib/llm-providers.ts`) | fixed 4 (`Automatic` and three) | — | never 1 |
| S4 | `app/src/components/settings/dictation.tsx` the Bubble's Bot row | `PickSurface` + `PickList` | `listEnabledProfiles`, as `botOptions` | 1 bot is the common case | each row's `detail` line — what that bot hears with | **applied** (quiet on a one-bot device; the detail line is settled below) |
| S5 | `app/src/components/bot-dictation-tab.tsx` Speech model | `PickSurface` + `PickList` | `modelsFor(settings, block)` | can be 1 | `ProbeNote`, and opening is what asks for the probe | **settled** |
| S6 | `app/src/components/bot-dictation-tab.tsx` `SettingSurface` — a host setting whose control is a pick | `PickSurface` + `PickList` | `pickOptions(block, row)` (`app/src/lib/stt-settings.ts`): the host's STT providers, or one provider's models | can be 1 | — | **applied** |
| S7 | `app/src/components/chat/model-picker.tsx` `ModelMenu`, drawn by `app/src/routes/chat.tsx`, `app/src/chat-next/chat-body.tsx` and `app/src/components/chat/chat-composer.tsx` | `Popup` + `ModelPicker` | `useModelInfo(profile).providers` | can be 1 | the Default row, the recent picks | **applied** |
| S8a | `app/src/components/bot-settings.tsx` General's Model row | `PickSurface` + `ModelPick` | as S7 | can be 1 | the Default row, a real write (`setDefaultModel(profile, undefined)`) | **applied** (quiet on a one-model host: the row runs the host's own model, which is that model) |
| S8b | `app/src/components/bot-settings.tsx` `ModelsPage` | as S8a | as S7 | can be 1 | — (`onPick` ignores `undefined`) | **applied** |
| S8c | `app/src/components/bot-settings.tsx` `SubagentModelRow` (Delegation) | as S8a | as S7 | can be 1 | the Default model row | **applied** |
| S8d | `app/src/components/bot-dictation-tab.tsx` Cleanup model | as S8a | as S7 | can be 1 | the Default row | **applied** |
| S8e | `app/src/components/bot-settings.tsx` `FallbacksPage` — a row and the add row | as S8a | as S7 | can be 1 | the None row; the add row's held value is empty by design | **settled** |
| S9 | `app/src/routes/research.tsx` `RewritePicker` | `Popup` + `ModelPicker` | as S7 | can be 1 | a Banner naming a host that won't let Gots pick, and the write's refusal | **settled** |
| S10 | `app/src/components/compare.tsx` `JudgePicker` | `Popup` + `ModelPicker` | as S7 | can be 1 | — | **applied** |
| S11 | `app/src/components/chat/bot-picker.tsx` `BotPicker` — the composer, a canvas, research and share | `DropdownMenu` radio group | `listEnabledProfiles` | 1 bot is the common case | — (a menu, not a sheet) | **settled** |
| S12 | `app/src/components/chat/slash-menu.tsx` the `/` palette | an inline menu over the composer | the local commands and `useSkills` | skills can be 1 | — (typed, not tapped) | **settled** |
| S13 | `app/src/components/bot-dictation-tab.tsx` `LevelPick` | a grid of cards in a `PickSurface` | `CLEANUP_LEVEL_ROWS` (`app/src/lib/speech.ts`) | fixed 4 | each card's purpose line | never 1 |
| S14 | `app/src/components/chat/model-picker.tsx` `DefaultModelSetting`, `FallbackModelsSetting` | `Popup` + `ModelPicker` | as S7 | — | — | no caller |
| S15 | `app/src/components/prompt-library-sheet.tsx` | `Popup` + `PickGroup` | the device's prompt library | can be 1 | a body preview and a pencil action per row | **settled** |
| S16 | `app/src/components/chat/mode-menu.tsx` `ModeOptions` | `PickGroup` in the Add-context sheet | `MODES` | fixed 3 (2 without the plugin) | each row's note | never 1 |
| S17 | `app/src/components/new-project.tsx` the project's bot | `Select` | the device's bots | 1 bot is the common case | the bot's name only | **not a sheet** |
| S18 | `app/src/routes/meetings.tsx` a meeting's project | `Select` | `No project` and the device's projects | 1 with no projects at all (`No project` alone) | — | **not a sheet** |
| S19 | `app/src/components/chat/mention-menu.tsx` the `@` palette | an inline menu over the composer, as S12 | the sessions and bots this device knows | can be 1 | each row's line | **settled** |

The applied sites are those whose sheet holds the list and nothing else: every row's second line is
part of the option, not a second thing to read.

A model pick's Default row survives the skip in the sense that matters: the moment the host offers a
second model the sheet opens again and that row is drawn with the others. A one-bot device finds S4
quiet rather than applying, because `getBubbleProfile` always resolves to the one enabled bot — there
is nothing to write, which is the state a tap on the one row would have left.

## The settlement

Each site below keeps opening. One option is taken; the others are recorded for the reader to choose
between.

**S1 — the host's enumerated settings.** Hides: the sheet's foot reads *Applies when this bot's
Hermes restarts.* for a field marked `restart`, and for many keys it is the only place the choices
are spelled out.

1. *(taken)* Keep opening. The note is drawn where the write is made.
2. Auto-apply only fields without `restart` — one branch, but a picker that opens for some keys and
   not others with nothing on the row saying which.
3. Auto-apply all, and draw the restart note on the page after the write — the note arrives after the
   restart it warns about.

**S5 — the speech model.** Hides: opening the sheet is what asks the host to measure a model
(`speech_probe`), and `ProbeNote` is where the measurement or its problem is read. A model applied
without opening is chosen with nothing measured.

1. *(taken)* Keep opening; the probe is asked where its result is drawn.
2. Auto-apply and start the probe behind the row, drawing `ProbeNote` there — the reader sees the
   measurement of a setting already written.
3. Auto-apply only a model the host already recommends, keeping the sheet where there is no
   measurement — two rules for one row.

**S4 — the Bubble's Bot row.** Hides: each row of the sheet carries the muted line naming what that
bot hears with (*Speech-to-text off* where it can't), which is how a reader picks a bot at all rather
than by name alone. On a device with one bot the tap is quiet and nothing is lost; it is the sheet
for two or more that carries the line. Applied, because the list is bots and nothing else, and named
here because G5 asks for every place a skip can conceal a line.

1. *(taken)* Keep applying, and keep the detail line on the row where one bot makes the sheet
   unreachable — the row already holds the bot's picture and name.
2. Settle it: keep opening, so the line is always read before the pick. Two or more bots already
   open, so this only changes the one-bot device, where nothing is written either way.
3. Apply and draw the line on the row itself for every count — a second line under a settings value
   that reads like a status rather than a choice.

**S17, S18 — the two `Select` pickers.** Hides: nothing, but the rule cannot reach them: a `Select`'s
list is the platform's own popup, not a sheet this app draws, so there is no sheet to skip, and a
select holding one entry still shows what is in force.

1. *(taken)* Leave both. The rule's own words — skip the sheet and apply the entry — have nothing to
   act on where no sheet is drawn.
2. Draw a plain value in place of the select when it holds one entry — a control that changes shape
   with the data, for a popup the reader may never open anyway.
3. Bring the two onto `PickSurface` and `usePickOne` — a real change of control on two screens, and
   not this change's.

**S8e — the fallbacks' provider row and add row.** Hides: the None row is how a fallback is removed
and how an add is cancelled, and the add row's held value is deliberately empty, so a skip appends a
fallback equal to the model the bot already runs with no way to back out.

1. *(taken)* Keep opening. A chain is a list of choices, and its rows hold an index, not a value.
2. Auto-apply a row that already holds a provider (replacing it with the sole model), keep the add
   row opening — the same sheet behaving two ways depending on which row was tapped.
3. Auto-apply both and move None onto the row as a delete control — a new control on a settings page.

**S9 — the rewrite picker.** Hides: the pick *is* the rewrite (a write that starts work), and the
sheet carries the Banner naming a host that will not let Gots pick a model.

1. *(taken)* Leave it opening, and name it here so nobody "finishes" the enumeration by applying it.

**S11 — the bot pill.** Hides: nothing; the control draws the bot in force and its menu row would be
that same bot, so a quiet tap is what the rule already gives without code.

1. *(taken)* Leave it. With one bot the tap changes nothing and writes nothing.
2. Hide the chevron and stop the menu opening when the device has one bot — a fact about the device
   drawn on a control that otherwise always opens.
3. Auto-apply and write the active bot on every tap — a write that changes nothing, once per tap.

**S12 — the `/` palette, and S19 the `@` one.** Not pickers: their rows are typed, and applying one
would insert or run the reader's command for them.

1. *(taken)* Leave both. They are menus over text already being typed.
2. With one match, insert it on the query and let the reader send — writing their message for them.

**S15 — the prompt library.** Hides: each row's body preview and its pencil, and the sheet is how a
saved prompt is read before its words go into the draft.

1. *(taken)* Leave it opening; a prompt is text, and picking one writes the reader's draft.
2. Auto-apply with one entry and draw the entry's name on the composer afterwards — the words land
   in the draft before the reader has read them.

## What a surface says while its list is not there

The two shared surfaces name their states; the rest draw what they hold. A list that is not ready
must never look like a list that holds nothing, since those are different facts about the host.

| Surface | While the list is reading | When the read failed | When the list holds nothing |
|---|---|---|---|
| `PickSurface` + `PickList` (`PickList` takes `options: PickOption[] \| undefined`) | *Reading this list…* beside a spinner | nothing of its own: a list that has not arrived keeps its reading words, and a read that failed is said on the page the sheet was opened from. None of these six sites reads a list that can fail on its own — the STT block is what draws those rows, and the bots come from the device — so a `failed` arm is owed only when a site does | *Nothing to pick from.* — and *Nothing matches.* when a search emptied a list that does hold options |
| `PickSurface` + `ModelPick` (`info: ModelInfo \| null \| undefined`) | *Reading this bot's models…* beside a spinner | *Couldn't read this bot's models.* | *This bot's host offers no models.* |
| `Popup` + `ModelPicker` anywhere but `ModelPick` (S7's sheet when it opens, S9, S10, S14) | the control that opened it shows the model in force — the host's last report, muted, where it is only remembered — and the sheet draws the Default row and the providers it holds | the same as reading: the sheet draws what it holds, and the row that opened it says the host's own words where the page draws refusals | the sheet's Default row stands alone; *No models match.* is only a search's |
| `Popup` + `PickGroup` (S15) | *Reading prompts…* beside a spinner | the sheet draws the library this device holds | *No prompts yet.* |
| the `/` palette (S12) | a foot row, *Loading skills…*, under the commands | the commands alone, silently, as a missing feature | the menu draws no rows at all |
| a dropdown (S11) | the trigger draws the bot in force; the menu draws the bots it has | the menu draws the bots it has | no rows |
| a fixed inventory (S2, S3, S13, S16) | — the list is a constant | — | — |

## Out of the enumeration, and why

- The sort menus (`app/src/components/sort-menu.tsx`, `app/src/components/project-usage.tsx`) order a
  list and write nothing.
- A segmented control (`Segmented`) and a switch are not a list to pick from.
- `RepoPicker` (`app/src/components/project-settings.tsx`) is a searchable list that adds, never one
  choice.
- `PickGroup` and `PickRow` (`app/src/components/pick-row.tsx`) are the row and its list, drawn under
  every sheet here and under surfaces that are not a pick of one value.
- `app/src/components/chat/attach-menu.tsx` — the composer's `+`, a `PickGroup` of tools whose rows
  are switches: two or more toggles, never one choice.
- `app/src/components/chat/outputs-drawer.tsx` — a turn's pull requests, a `PickGroup` whose rows
  open one; the list is what the turn produced, not a value to set.
- `ValueForm` (`app/src/components/bot-dictation-tab.tsx`) draws a `PickSurface` around a value typed
  in by hand: a form, not a list to pick from.

The app has **no skill-picking sheet**: a bot's skills are switches (`app/src/components/skills-tab.tsx`),
and the only "choose a skill" surface is the `/` palette (S12), typed into the composer.

## What holds this page to the code

`app/scripts/test-pickers-doc.mjs` reads `app/src/` for every file that renders `<PickSurface`,
`<PickList`, `<ModelPicker`, `<ModelMenu`, `<PickGroup` or `<Select` — leaving out the modules that
only define them (`app/src/components/pick-row.tsx` and `app/src/components/ui/select.tsx` among
them),
`app/src/components/settings-chrome.tsx` and `app/src/components/chat/model-picker.tsx` — and reads
this page for the files it names. It fails on a file that draws one of those surfaces with no row
here, on a row whose surface column says it draws one while its file no longer does, and on a site
with two rows. A picker added later declares itself here; a file named here by its path from `app/`
is what the test matches on.

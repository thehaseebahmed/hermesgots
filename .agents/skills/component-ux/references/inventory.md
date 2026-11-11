# Component inventory

Every file under `src/components/` as the app stands, with **importers** — the modules that import it,
lazy `import()` included, itself excluded. The count is the point: a component with one importer is a
surface that shows in one place, and a component with none is dead. LOC is context, not a judgement.

Counted by reading the import graph of `app/src` (405 files), not by hand:

- 156 component files — 126 app components, 30 shadcn/Base UI primitives.
- 9 app components with 10+ importers, 27 with 4–9, 42 with 2–3, 48 with exactly 1, and none dead
  on the app side. One primitive has never been imported (`ui/toggle-group.tsx`).

The families below are the ones the skill's table names. The last two sections are the answer to
"this isn't reused — what should it be?": the one-offs worth folding, and the ones that are
legitimately single-use.

## The spine

| Component | Importers | What it is | When it shows |
| --- | --- | --- | --- |
| `ui/button` | 69 | The action | Any action. `primary` once a screen |
| `ui/spinner` | 37 | The loader | Beside the words of anything running |
| `popup` | 31 | Sheet / drawer / menu | Anything over the page (ADR 0141's foot excepted) |
| `bot` | 22 | A bot's artwork | Wherever a bot is named: a row, a card, a header |
| `banner` | 17 | A one-line notice | Top of a screen or sheet, above its subject |
| `chat/code-face` | 15 | `CODE_FACE` / `CodeFaceProvider` | A code session's mono face, at both chat screens' root (ADR 0069, 0087) |
| `settings-chrome` | 14 | `Screen`, `Group`, rows, `EditForm`, `PickList`, `ConfirmDestructive` | Every settings-shaped screen, and the AFK and skill-detail pages that borrow its rows |
| `ui/alert-dialog` | 13 | The question | A destructive confirmation, through one of the two wrappers |
| `chat/markdown` | 10 | The reply's renderer | A reply, a bubble, a card's prose |
| `chat/chat-header` | 13 | The bar | Every child screen (ADR 0140): a chat, a room, a routine, a project, canvas, Code, Projects, Meetings, Research, a bot's list |
| `confirm-destructive` | 15 | The question | A delete, a remove, a discard — and it owns the write (ADR 0142) |
| `pick-row` (`PickRow`, `PickGroup`) | 8 | A row a pop-up offers | The model picker, settings picks, Mode and Tools, a Prompt, the `/` menu, both PR surfaces (ADR 0142) |
| `search-field` | 7 | The search | Every list, sheet, picker and form |
| `item-list` | 8 | `ItemRow`, `ItemGroup`, `SearchField` | Projects, Code, Meetings, Research, a bot's chats, the Canvas list |

## Pills and chips

| Component | Importers | When |
| --- | --- | --- |
| `chip` (`Chip`, `ChipRow`) | 4 | A row of filter alternatives, 44px, pressed state |
| `repos` (`RepoChips`) | 2 | A project's repos and branches — read-only metadata, not a control |
| `chat/pill` (`PILL`) | 3 | The chrome of the row above a composer: todos, outputs, PR |
| `experimental-badge` | 4 | A feature that can break, where it is turned on or picked |
| `ui/badge` | 9 | A category, a state word |
| `segmented` | 7 | One of a few values: a radio group of pills, not a chip filter |

## Rows

| Component | Importers | When |
| --- | --- | --- |
| `item-list` `ItemRow` | 8 | A list of things: disc, bot corner, title, age, one line, unread dot |
| `settings-chrome` `RowText`/`LinkRow`/`SwitchRow`/`ValueRow`/`SplitSwitchRow` | 14 (kit) | A settings-shaped page |
| `pick-row` `PickRow` | 8 | A row a pop-up offers: a mark, a name, one muted line, a tick or a chevron by its mode |
| `pr-row` `PrRow` | 2 | A pull request as a pick row, opening on GitHub |
| `bot-card` `BotCard` | 2 | A bot as a small card, in a strip |
| `library` `FileRow`/`FolderSection` | 2 | A project's library tree |

These were four of the seven hand-drawn rows this inventory found; the pick-row round (ADR 0142)
made them one `PickRow` in a `PickGroup`, and what is left above is that component and its callers.

## Cards and groups

| Component | Importers | When |
| --- | --- | --- |
| `settings-chrome` `Group` | 14 (kit) | A group of settings rows: 24px card, hairline between rows |
| `ui/card` `Card` | 8 | A feature card: a bot gallery card, a routines job, an account panel |
| `chat/session-cards` `CARD_BASE`/`CARD`/`FLAT_CARD` | 7 | A card in a thread: question, approval, plan, resolved |
| `chat/approval-card`, `chat/question-card` | 4, 3 | The two cards a run waits on |
| `openui/library` | 3 | The components a reply's interface may use |

## Overlays and confirmations

| Component | Importers | When |
| --- | --- | --- |
| `popup` | 32 | The only sheet / drawer / menu |
| `confirm-destructive` | 15 | A destructive yes-or-no, holding its write and the host's refusal |
| `chat/session-leave` | 1 | Three ways out of a session: keep, discard, stay |
| `chat/rename-dialog` | 2 | A one-field rename, in a dialog |
| `fullscreen` (`FullscreenPopup` in `popup`) | — | The Previewer and the meeting recorder |

## Notices, lines and state

| Component | Importers | When |
| --- | --- | --- |
| `banner` | 17 | A state of the screen, above its subject |
| `chat/system-line` | 2 | The app talking about the thread |
| `chat/status-line` | 4 | What a reply is doing, in the thread |
| `chat/work-row` | 4 | A reply's work row: 29px, one of three (ADR 0058) |
| `chat/empty-states` | 3 | A thread with nothing said |
| `ui/skeleton` | 5 | A shape about to fill |
| `crash-screen` | 2 | The app failed to start |
| `device-state` | 1 | The device has no database |
| `ui/sonner` | 1 | The toast host; `toast()` is the API |

## Chat thread parts

`chat/message-item` (4) draws the row; `chat/user-bubble` (4) the user's words; `chat/tool-card` (1)
a call's details; `chat/tool-group` (1) a run of calls; `chat/agent-card` (4) a delegated agent;
`chat/thinking-line` (1) a thought row and its sheet; `chat/subagents` (2) and
`chat/subagent-count` (2) the count and the sheet; `chat/todos` (2) the todos pill and list;
`chat/usage-sheet` (2) the context meter; `chat/outputs-drawer` (2) PRs and files; `chat/composer`
(6) and `chat/chat-composer` (1) the composer; `chat/model-picker` (6) the model list; `chat/
attach-menu` (1) the `+` sheet; `chat/attachments` (3) and `chat/media-gallery` (4) what was attached;
`chat/previewer` (8) the full-screen file view; `chat/mode-menu` (3), `chat/model-change` (3),
`chat/step-rail` (2), `chat/divider` (1), `chat/first-rows` (2), `chat/follow` (2),
`chat/library-pill` (2), `chat/canvas-points` (5), `chat/cheatsheet` (3), `chat/slash-menu` (1),
`chat/reminder-row` (2), `chat/routine-chat` (1), `chat/voice-bar` (1), `chat/code-block` (2),
`chat/markdown-renderer` (1).

## Single-use screens and tabs

Each is imported once, by the route or tab that owns it — being single-use is correct for a screen.
They are listed so the next person knows the surface exists before writing another.

`afk` (662) and `afk-prompt` (261) — the away workflow and its prompt. `bot-settings` (1251),
`bot-coding-tab` (290), `bot-dictation-tab` (1052), `bot-llm-providers-tab` (974), `skills-tab` (322),
`mcps-tab` (1524) — a bot's settings pages. `project-settings` (518), `new-project` (355),
`project-usage` (265), `new-session` (151), `conversation-list` (770), `library` (299),
`list-foot` (219), `compare` (586), `research` (435), `network-log` (162), `feedback` (112),
`canvas-consent` (403), `device-state` (133), `app-shell` (273), `pane-transition` (100),
`break-reminder-provider` (244), `keyboard-shortcuts` (36), `skill-detail-sheet` (241),
`prompt-library-sheet` (211), `link-bots` (196), `account-settings` (490), `community-settings` (107),
`settings/appearance` (137), `settings/dictation` (638), `room/*` (five files, 363–69),
`openui/*` (a reply's interface library).

## One-offs that map to something

The verdicts are the three from `SKILL.md`; each finding is written up with evidence in
`deviations.md`.

| One-off | Importers | Maps to | Verdict |
| --- | --- | --- | --- |
| `chat/todos` ring spinner | 1 | `ui/spinner` | Fit it |
| Projects / Meetings / Code empty states | 3 copies | new `EmptyState` | Make it a rule — `no-component-at-all.md` |
| 16 hand-written page columns | 8 files | `Screen`'s column, or a `PageColumn` | Make it a rule — `no-component-at-all.md` |
| 18 ad-hoc `rounded-3xl border bg-card` cards | 6 files | `ui/card`, once its radius is the app's | Make it a rule — `no-component-at-all.md` |
| `ui/toggle-group.tsx` | 0 | nothing — an unused shadcn primitive | Delete |

Done in the pick-row, confirmation, search and bar round (ADR 0142): `PrRow`, `SheetPickerRow`,
`SkillRow`, `PickList`'s row and the model picker's row became `PickRow`; `ConfirmDialog` and the six
hand-written confirmations became `ConfirmDestructive`; four hand-drawn searches became
`SearchField`; six hand-written bars became `ChatHeader`; `skill-sheet.tsx`, `skill-row.tsx` and
`sheet-picker.tsx` were deleted.

## Single-use and correctly so

`chat/chat-composer` (the blank chat's one composer), `chat/thinking-line` (a thought row owns its
sheet) and `openui/chart-surface` / `openui/map-surface` (lazy, one library each) have one caller
each and are not one-offs: each is a primitive whose first caller is its screen. A future audit
should leave these alone; the exception register says so.

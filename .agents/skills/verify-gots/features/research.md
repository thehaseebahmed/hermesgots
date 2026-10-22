# Research

Research turns a question into a guide. The user asks what to research; the mission reads their
question back as a brief, passes a Scope Gate the user approves, reads and drafts, and delivers a
guide — with citations whose sources open beside the claim, a header Sources button, revisions from
the options menu, and a rewrite with another model.

## Sub-features

- `research-ask` — a question opens a mission with the brief read back from it (`research`).
- `research-scope` — the Scope Gate names the goal and `Approve and start research` starts the work
  (`research`).
- `research-deliver` — reading and drafting land in a delivered guide (`research`).
- `research-format` — another format rewrites the guide (`research`).
- `research-cite` — a citation opens the Sources drawer on its claim; the header's Sources button
  lists them (`research`).
- `research-missed` — questions it missed are read for and the guide written again around them
  (`research`).
- `research-revise` — revisions from the options menu, and a rewrite with another model (`research`).

## How to get to it (user POV)

- The sidebar's `Research` link → `/research`: the mission list, `New research`.
- The `What to research` textbox and `Start`.
- A mission at `/research/<id>`: the brief, the Scope Gate's `Continue` and
  `Approve and start research`, the guide, a citation in its text, the header's `Sources` button.
- The mission's options menu for revisions and a rewrite.

## Driving it with the e2e flows

Preconditions:

- Baseline state (features/README.md). The mock's research missions live in
  `app/scripts/mock-research.mjs` and seed the list with a mission titled `How transformers work`.
- The flow drives three widths: 390 (phone), 1100 (tablet) and 1440 (laptop, where the mission sits
  beside the list), and collects console errors at each.

- **Ask.** Open Research and start a mission. Run
  `pnpm e2e research --shots "$GOTS_VERIFY_ARTIFACTS/<run-id>"` (from `app/`). At laptop width
  `getByRole("button", { name: "New research" })` opens the question beside the list (from 1280px);
  `getByRole("textbox", { name: "What to research" })` takes `Explain transformers` and
  `getByRole("button", { name: "Start" })` opens `/research/r_*`.
- **Brief and scope.** The same flow: `Reading your question` shows, then `Continue` appears over a
  brief whose `Goal` input reads `Understand transformers…`; `Continue` leads to the Scope Gate, whose
  `Approve and start research` starts the work.
- **Deliver.** Reading and drafting land in the delivered guide — the flow waits for the delivered
  state and screenshots it (`research-*.png` at each width).
- **Another format.** Pick another format in the mission: the guide is rewritten in it.
- **Citations.** A citation in the text opens the Sources drawer on its claim (with a card on hover
  with a mouse), and the header's `Sources` button lists them; a source card names the source.
- **Missed questions.** Questions the mission missed are listed, `Read` for them re-reads, and the
  guide is written again around them.
- **Revisions.** The mission's options menu lists its revisions and offers a rewrite with another
  model; each lands as a new revision of the guide.
- **Proof of a whole pass.** `research-*.png` at 390, 1100 and 1440 (the mission beside its list at
  laptop width), the `PASS:` transcript, and no console errors at any width (the flow fails on any).

## Gotchas

- Research is behind a feature switch and is a lazy import: a screen that never loads its chunk is
  often a stale Vite dependency graph (`504 (Outdated Optimize Dep)` in the console), not a
  regression — restart the app before reading it as one.
- The list and the mission are one screen from 1280px (the pane) and two below it. Assert at the
  width the journey claims; a laptop assertion about "beside the list" is meaningless at 390.
- The `Goal` input's value is the mission's own words from the question — assert the prefix
  (`Understand transformers…`), not a fixed string.
- `New research` beside the list is a laptop-width entry point only; on phone and tablet the flow
  opens `/research` and starts from there. Report which entry point was driven with the proof.
- A hover card needs a mouse: the flow moves the real mouse to the citation. A synthetic focus won't
  open it.

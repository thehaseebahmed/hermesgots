# A test belongs to the cheapest tier that would fail for its reason

Sixty browser flows is what "everything a unit test cannot do goes to end-to-end" produces. The unit
tier is a pure rule: a module of TypeScript run by `node --test`, with no DOM, no database and no
HTTP. So a change that renders a screen, opens a sheet or reads the device's database has exactly
one home — a flow, with a dev server and up to four test hosts behind it — and the set only grows.
Nothing asks a flow to justify itself, and a flow nobody runs never argues for its own deletion, so
each one is a permanent cost paid for a single assertion.

Three tiers, each owning a class of failure rather than what is left over:

- **Unit** — a pure rule: a derivation, a parser, a placement, a string. No DOM, no database, no HTTP.
- **Component** — how the app renders and wires those rules: a screen or sheet rendered over a
  seeded device database with the HTTP boundary faked, in one process, in CI.
- **End-to-end** — what only a real browser against a host can show: a stream that survives a
  reload, a request or write budget measured over wall-clock, a run started somewhere else, a
  compression mid-run, real layout at two widths.

The question between them is not "can a unit test do this?" but **which is the cheapest tier that
would fail for the reason this change can fail?** A test belongs there. A flow is not the default;
it is the claim that the lower tiers cannot reach the behaviour.

Three and not two, because the boundary the middle tier exists for is the DOM: a rule's answer over
a rendered tree is neither a pure function's nor a browser's, and two tiers would leave it with
nowhere to be asserted but a browser. The middle tier runs in one process, opens no port and needs
no Python, so it costs about what reading the test costs, and it can hold a seeded database, a timer
it controls and an answer at the HTTP boundary — everything a screen's behaviour is made of. What it
cannot do is geometry: a DOM without layout has no sizes, so a test that asserts a pane's adjacency
or an element's height would pass whatever the CSS says.

## Considered options

- **Two tiers, with end-to-end by residue.** The shape the repository has now, and the one that got
  it to sixty flows. Rejected because a residue has no ceiling: every change that touches a screen,
  however small, is an argument for a browser, and nothing punishes a sixty-first flow. The cost is
  not the flow that is written but the sixty that stay, each one run by hand and rarely read against
  what it asserts.
- **Per-flow judgement, with no rule at all.** Weigh each flow on its merits, the way a team does
  when it decides whether a test is worth writing. Rejected because it cannot be pointed at in
  review: two people weigh the same flow differently and neither is wrong, so the set drifts with
  whoever last argued hardest. The rule is worth having for the argument it settles, not for its
  precision.

## Consequences

- **A new flow is an argument, not a default.** A pull request that adds one has to say why the
  lower tiers cannot reach the behaviour. The template's checklist asks for the tier, and that is
  the whole mechanism: the rule's only enforcement is that a reviewer can point at it and ask the
  question.
- **The component tier is the price of the boundary.** It is machinery the repository did not have:
  a runner, a seeded database, a faked HTTP boundary and tests written against the app's own client
  types. It is also the tier most work lands in, so it has to stay inside the two-minute budget
  (ADR 0002) — a gate people run at the end of the day is a gate they run after the work is done.
- **Geometry escalates to the sweep.** Layout that a DOM cannot measure — a rail's row heights, pane
  adjacency at a tablet width, a menu's height cap, a full-viewport cover — is asserted by a real
  browser or it is asserted by nothing. A component test that appears to check it would pass
  whatever the CSS did, which is worse than no test.
- **What a component test proves is a shape TypeScript already pins.** Its fake at the HTTP boundary
  answers what the app's own types say, not what the plugin really answers. The plugin's real
  answers are proven by its own suite, and at the seam by the sweep; a component test that grows
  responses the plugin should produce would be a second, quieter test host.
- **The flows do not leave in one change.** Each demoted flow is deleted only once its replacement
  at the lower tier is green, and the replacement carries the old assertions rather than re-deriving
  them, so there is never a moment when a behaviour is protected by nothing. Until then the count
  stays where it is, which is the honest price of not losing coverage mid-migration.
- **The tiers name where a failure is caught, not how a feature is built.** A pure rule is still
  worth extracting because it is testable, a screen still worth rendering without a host for the
  same reason, and neither is a reason to change what Gots does for a user.

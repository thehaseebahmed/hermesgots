# A canvas is checked on its host, drawn the way the app draws it, after its run ends

(2026-11-19, planned in `docs/plans/2026-11-19-canvas-builds.md`; not built yet.)

A canvas's write was checked by `scan` and `warnings` and nothing ran the page. **A build's draft is
now rendered by the plugin through Hermes's own browser backend, inside a harness generated from the
app's own frame-document code** — its policy, tokens, class compile and library sources in one
self-contained page checked into `plugin/canvas/` with a drift gate, as the guide and the library
list already are. The plugin runs the build plan's tests in it against a read-only snapshot of the
canvas's data and takes screenshots at 390px and 768px in light and dark. A page checked through a
different document than the app draws would test the wrong page, which is why the harness carries
megabytes rather than raw HTML.

**The check runs after a build's run ends, and its report is posted as the next turn**, the
screenshots inline as image parts, for up to three rounds. Inside a tool call, four renders could pass
Hermes's tool timeout on a slow host; as a turn, nothing waits on the agent choosing to check. Checks
still failing after the rounds publish the version flagged failing, and a host with no browser
publishes it marked unchecked: a build never stalls on its checks.

That a plugin can call Hermes's browser layer at all is unverified, so a probe is built first, and
the work stops for the user's word if no entry exists.

## Considered and rejected

- **The agent testing with Hermes's browser tools.** Publishing would trust that it did.
- **The plugin shipping its own headless browser.** A new install on every host.
- **`browser_vision`.** It needs an auxiliary vision model; `/v1/runs` already takes images.

## Consequences

- A browser on the Hermes host now runs script the bot wrote, inside the frame's policy.
- A library update must regenerate the harness.
- A test of a page that writes data passes against a snapshot, not the host.

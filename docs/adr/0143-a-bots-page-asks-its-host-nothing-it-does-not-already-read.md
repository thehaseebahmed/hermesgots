# A bot's page asks its host nothing it does not already read

The bot's own page carried a _Test connection_ row whose whole row was the tap. It asked the host's
health, read its model list and read the plugin's version, then printed what came back under the row.
Three requests for one line, and two of them fed nothing the page draws: the model list was read to
repair a profile pointing at a model the host no longer lists, and the health probe was a fact no
control on the page could act on. The version it named was already on the wire besides — every page of
a bot's settings reads the plugin's `info` to decide which rows a host can withhold, and that answer
carries the version.

**So the test row is gone, and the version rides the read the page already makes.** A _Plugin_ row at
the foot of the bot's own card reports what the host runs, off the same remembered `info` answer the
gates read: one hook beside `usePluginFeatureAnswers`, so one answer per connection and no request of
its own (ADR 0128). Where the host answered without a version the row reads _No plugin_. While the
answer is still owed the row holds no value line at all, because "Not set" would be a claim about a
host nobody has heard from yet.

**The version is a fact the page reports, not a setting it holds.** The row opens nothing and writes
nothing on a tap: it reports what is there rather than a setting to change (ADR 0055). It also stays
where the test row sat rather than moving to a page of its own: the plugin belongs to the bot's Hermes,
but the _Hermes_ card is drawn for unlinked bots only, and every bot has a plugin version worth naming.

**What the device keeps follows the host, and only from a live read this session.** `pluginVersion` is
what the out-of-date banner and the Settings menu's tag read, so it has to be the host's fact rather
than this device's memory: it is written only when the answer came from a read taken from the host in
this session, never from the copy the device kept from an earlier open (ADR 0132), and only when it
differs from what is stored. A host that has updated therefore clears its own banner on the next
visit to its page, and a host that is away changes nothing — its banner stands on the last fact anyone
had.

**A failed read offers its own retry, and nothing else does.** Every other read a bot's settings page
makes — General, the provider list, the speech settings, the pick budget, an MCP server's
configuration — draws one notice carrying the host's sentence and one control that re-runs exactly the
read that failed. A host that answered without the thing asked for gets no control, since an answer is
an answer; and the out-of-date banner gets none either, because nothing failed there — the host
answered, and the answer is old. A retry is a person's tap on a read that threw, never a timer, so
opening a page still costs the host only what the page draws.

## Considered options

- **Keeping the test row and dropping its extra reads.** The row would then be a tap that asks `info`
  a second time to print a version the page already holds, in a row whose only purpose was the tap.
- **A _Plugin_ row carrying a _Check for updates_ action.** The page has no action to take on a
  version it did not choose: the plugin is installed on the host, and the banner already says when it
  is behind.
- **Writing the stored version from whatever answer is drawn, the cached copy included.** A version
  read from this device's own memory (ADR 0132) would overwrite the host's with an older fact, and the
  banner would stand over a host that had updated.
- **Reading the version through `getPluginVersion` when the page opens.** A second request for a
  string the first one already carried.
- **A retry on every failed read, a host that answered without the block included.** A control that
  re-asks a question already answered does nothing, and it teaches a reader that the notice's button
  is decoration.

## Consequences

- Opening a bot's page asks its host for one `info` read and nothing else about its connection: no
  health probe and no model list.
- The test row's two side effects are gone. A profile pointing at a model its host no longer lists is
  no longer repaired from this page, and the context window is no longer re-synced by it. Chat actions
  still sync on a model pick, and Models is where a model is chosen.
- The banner can appear or disappear as a bot's page is opened, because the stored version follows the
  host rather than a tap.
- A version-only `info` answer is not remembered — an answer naming neither features nor rooms keeps
  nothing (ADR 0128) — so a host that answers a version and nothing else draws the row as owed rather
  than naming the version it runs.
- The stored version is written on every open where it moved: a device write with no request behind
  it, on each visit to a host whose plugin has changed.

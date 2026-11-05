# A pinned session stands above the four groups

The Code list answers one question in its order — what needs the reader — and every session is folded
into **Waiting for You**, **Working**, **Idle** or **Closed** by the claim it currently holds (ADR
[0046](../0046-the-code-list-is-arranged-by-status-and-a-dot-marks-what-this-device-hasnt-read.md),
[0053](../0053-a-run-in-flight-is-the-code-lists-primary-claim.md)), while its place inside a group
is the sort control's ([0091](../0091-a-sort-is-a-key-and-a-direction.md)). A session the reader
comes back to all day has no way to stay where they can see it: it changes group whenever a run
starts or a wait lands, and nothing in the list holds it still. So a session can be **pinned**, and a
pinned session is drawn in a **Pinned** band above the four, read off the session's own `pinned`
rather than off any claim the list derives. The pin is positional and nothing else — it changes no
session's state, no model, no cleanup — and it moves the row out of its status group rather than
mirroring it there. The band runs the same order as every group, so the sort control keeps one
meaning. While a
search or a project chip filters the list the band drops away with the other headers, because
filtering is already the list with its headers removed. The toggle is a row in the session's own
options menu, beside Mute, because an `ItemRow` wraps its whole body in a single link or button and a
trailing control inside it would be nested interactive markup. A pin outlives the session's status: a
pinned session that falls to Idle or Closed stays in the band.

## Considered options

- **A fifth key in `CODE_LABELS`.** The record is the group vocabulary *and* the order, so a fifth key
  would draw the band only by reordering inside the one fold that also drops empty groups and decides
  membership — and then one function would answer both "which claim holds this row" and "where did the
  reader put it". The band is not a claim, and the code should not say it is.
- **A fourth sort key.** A key ranks the rows a group already holds (ADR 0091), so it cannot lift a
  row above its group at all; the pick is stored per device, so the same pin would order differently
  on two devices; and ADR 0095 keeps the control at one sign and one name, which a second meaning for
  a key would break.
- **Drawing the row in both places.** Then one session is two rows, six e2e flows look their group up
  by region name and hit a strict-mode duplicate, and the count in two headers is the same session.
  Apple Notes moves a note into its Pinned section rather than copying it.
- **Ordering the band by pin time, as the project list does.** `projects.tsx` sorts pinned projects by
  their `pinnedAt` because that list has no sort control, and stores the moment for it. The Code
  screen has one, and a band that ignored it would be the single group where the arrow does nothing —
  so the session's flag is a boolean, not a moment.
- **A device-local pin, the read mark's shape.** A read mark records what this device has seen; a pin
  records what the reader wants, and the project list's pin already follows the account. Read marks
  stay local ([0046](../0046-the-code-list-is-arranged-by-status-and-a-dot-marks-what-this-device-hasnt-read.md));
  a pin does not.
- **Cleanup sparing a pinned session.** A session with nothing in it is swept, and a pin on one is a
  pin on a session the reader never used. Tying the pin to cleanup would make it a protection rather
  than a place, and then its name would promise more than the list does.

## Consequences

- **A pinned session stops counting under its group.** Pinning a session that waits on the reader
  takes it out of **Waiting for You**, so that header's number falls — and when it was that group's
  only session, the group goes entirely and the band stands above **Working** or **Idle** instead.
  The row keeps its tone and glyph, so the wait is still visible; it is just no longer counted, and
  that is the trade the band costs.
- **A device can clear a pin written on another, and a pin can carry a stale record over a fresh
  one.** Sync merges a whole chat record on one clock (`plugin/chats.py`, "Keeps whichever record is
  newer"), so a device saving an older copy of the record drops the pin — and a device that pins from
  a copy already behind publishes that copy as the newest record, so a mute or an unsent draft the
  other device wrote in the meantime goes with it. `muted` carries the same cost, and the pin inherits
  it rather than adding a per-field merge for one boolean.
- **The e2e flow must gain the band, or silently stop testing order.** `app/scripts/e2e/code-list.mjs`
  asserted the group order through a whitelist of labels, so a new band would have passed unnoticed —
  its `headings()` helper now reads every section in the list column instead, so a group nobody listed
  fails the sweep. The flow pins a session from its options menu and unpins it again, so the band is
  drawn, left, and gone.
- **The word now has two senses in the tree.** *Pin* is the model a chat keeps (`pinModel`,
  `chats.pin()`, the glossary's **Pin**), and *Pinned* is a place in a list — already true of projects
  before this change. The glossary separates them. The chat record keeps the model in `modelChoice`
  and the list placement in `pinned`, while the plugin's own `pinned` argument still names the model
  pick — so the field a rule reads is what tells the two apart, not the word.

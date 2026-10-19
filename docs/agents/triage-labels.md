# Triage Labels

The skills speak in terms of five canonical triage roles. This file maps those roles to the actual label strings used in this repo's issue tracker.

| Label in mattpocock/skills | Label in our tracker | Meaning                                  |
| -------------------------- | -------------------- | ---------------------------------------- |
| `needs-triage`             | `needs-triage`       | Maintainer needs to evaluate this issue  |
| `needs-info`               | `needs-info`         | Waiting on reporter for more information |
| `ready-for-agent`          | `ready-for-agent`    | Fully specified, ready for an AFK agent  |
| `ready-for-human`          | `ready-for-human`    | Requires human implementation            |
| `wontfix`                  | `wontfix`            | Will not be actioned                     |

AFK also has one mark of its own, which is not a triage role: `gots-got-it`. It is the claim — the mark
AFK puts on a task it has taken, and takes off again if that session is discarded or fails, so the same task
is never worked twice (`docs/adr/0012-a-task-is-claimed-on-github-not-in-gots.md`). A task carrying it, or an
assignee, is out of the frontier; leave it alone when triaging.

When a skill mentions a role (e.g. "apply the AFK-ready triage label"), use the corresponding label string from this table.

Edit the "Label in our tracker" column to match whatever vocabulary you actually use.

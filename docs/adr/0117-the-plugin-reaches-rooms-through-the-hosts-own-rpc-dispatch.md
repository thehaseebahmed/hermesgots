# The plugin reaches rooms through the Host's own RPC dispatch

Rooms live in the Host's gateway, and the gateway's way in is its JSON-RPC surface — `groups.*`,
declared in the Host's contract catalog and validated on the way in and out. The API server the app
talks to has no group routes at all: it serves a member gateway's room dispatch and a room's grants,
and nothing a client could create or send with.

**The seam is one module, tried in process first.** The plugin's routes run inside the same Hermes
process as the gateway, so the module hands the Host's own dispatcher a `groups.*` request and gets
the Host's own answer — the same handler, the same contract validation, the same typed refusals the
desktop sees. When that import or call fails, the module falls back to the Host's own gateway client
over its loopback control socket, which is the supported client a CLI uses. When neither answers,
`rooms` is not advertised, and the app draws no room and no New room rather than an error.

**Advertised only where the driver runs.** A Host can serve rooms and be unable to work them — its
room worker down, its log store unready. A room created there would be accepted and never answered,
which reads to the user as a bot that ignored them. So the feature is gated on the Host reporting a
running driver, and not on the methods merely existing.

**Rejected: calling the Host's room service object directly.** It is the most direct thing in the
process and the least right one: a private attribute rather than a contract, with no validation, no
capability check and no idempotency envelope, and it binds the plugin to an internal the RPC layer
exists to protect.

**Rejected: a room engine in the plugin.** See ADR 0115: a second roster, log and round loop drifts
from the Host's own and re-implements leasing, cancellation and idempotency.

**Rejected: a `/v1/groups` surface on the Host's API server.** It would put a Host change on this
feature's critical path, and it would duplicate one layer up a surface that already exists one layer
down. If a later Host wants a network surface for rooms, that is its decision to make, and the
plugin's seam is method-shaped so it can follow one.

**What follows, and is accepted.** A Host without the dispatcher, the loopback client or the driver
has no rooms in Gots, and no error either. The plugin's test suite has no Hermes installed, so its
tests stub the seam; the half a fake cannot prove — a real gateway answering, and a room made in the
desktop appearing in Gots — is a checklist item on the step that builds it.

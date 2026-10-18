# Migrations: moving the app's calculations to the plugin

These files are the remaining work of `docs/adr/0006-calculations-belong-on-the-plugin.md`, split so an
agent can pick one up without re-deriving the design. Each is a work order: the goal, what the code does
today, the contract to build, the steps, the pitfalls that bit the first cluster, and how to know it is
done.

Read `docs/adr/0006-calculations-belong-on-the-plugin.md` first — it is the decision these follow, and it
names what stays in the app. `fixes.md`'s last pass is the same three clusters in shorter form; when a
cluster lands, **delete its entry there** and correct any `AGENTS.md` sentence that describes the old
behaviour (that file is a second copy of the truth and goes stale silently).

## Order

| # | File | Cluster | Why here |
| --- | --- | --- | --- |
| — | `cluster-a.md` | Todo progress and depths | **Done.** Kept as the worked example: it is the shape every other cluster follows. |
| 1 | `cluster-b.md` | Context window | First, because it builds `plugin/models_dev.py` — the plugin's own models.dev fetch and cache. Cluster C's prices come from the same payload, so C depends on B. |
| 2 | `cluster-c.md` | Usage cost | Reuses B's catalogue to price what Hermes left unpriced, and deletes `src/lib/pricing.ts`. |
| 3 | `cluster-d.md` | Tool results | Independent of B and C, and the widest: a new route, a shape on every stored tool row and the live path. Last. |

The last of the three to land also does the release bookkeeping the decision defers to the end: bump
`plugin/plugin.yaml`'s version and `MIN_PLUGIN_VERSION` in `app/src/lib/version.ts` together, and add the
capability flags this work introduced to `AGENTS.md`'s route list.

## The shape every cluster follows

Cluster A is the template. Each one:

1. **The plugin works the fact out and states it** on the route that already owns it — no aggregate route,
   so each capability flag gates exactly one feature.
2. **A capability flag goes in `info`'s `features` list** (`plugin/__init__.py:237`), named for the fact
   rather than the screen. The app gates on it: `lacksRoute(server, error, "<flag>")`
   (`app/src/lib/cooldown.ts:22`) reads a 404 as "this plugin is older", and `features.includes(…)`
   (`app/src/lib/model-info.ts:30`) is the direct form. `getPluginFeatures` is asked once per server and
   key (`app/src/lib/hermes.ts:682`).
3. **An older plugin degrades to nothing**, never to a differently-computed number: the app keeps no
   fallback implementation of a fact the plugin authors.
4. **A derived fact is stored beside what it describes** (`app/src/lib/db.ts`), with a Dexie version bump
   per cluster that changes a shape — and an upgrade that drops the stale value rather than keeping a
   half-filled one, since nothing in the app may fill it in.
5. **The mock mirrors the new contract** (`app/scripts/mock-hermes.mjs`), or the e2e flows are asserting
   behaviour the real plugin no longer has.
6. **Docs move with it**: `AGENTS.md` (the prose paragraph and the layout row), `plugin/README.md`'s route
   line for the plugin's half, and the `fixes.md` entry deleted.

Gates before every commit: `python3 -m unittest discover -s plugin/tests` from the repo root (it stubs
Hermes, so it runs anywhere), then `pnpm lint`, `pnpm typecheck` and `pnpm build` from `app/`, plus the
browser flows for anything touching chats, sessions, polling or sync (`pnpm e2e <flow>`, `pnpm e2e list`).

`docs/adr/0006-...` settled one thing that constrains all of them: **the change stream stays
content-free.** `plugin/events.py` writes rows with no payload and the plugin holds no tool result at hook
time, so a derived fact reaches the app on the next read of its route. An event (or the trigger cluster A
used: the tool call itself, then a retry timer) only tells the app *when* to read.

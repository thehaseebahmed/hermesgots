/**
 * The AFK pop-up's pick count, over a seeded device database and a faked HTTP boundary: every task
 * AFK holds as a Working row of its own — its number, title and stage — over the count of them
 * against the project's pick count, the line under its heading saying what a pick counts; the count
 * set on the host from the row under the switch, one write of its own, with a refused one leaving
 * the count it had; and a plugin from before the count drawing exactly the sheet it always drew.
 */
import assert from "node:assert/strict"
import test from "node:test"

import {
  afkHost,
  click,
  connection,
  findAll,
  find,
  json,
  mountAfk,
  seedSettings,
  type HoldRow,
} from "./component-kit.tsx"

const config = { baseUrl: "http://hermes.test/v1", apiKey: "test-key" }
const project = "project-1"
const FEATURES = ["afk", "afk_switch", "afk_workflows", "afk_pipeline", "afk_prompt", "afk_picks"]

/** Three tasks held at once, the first two with a stage their own session is in. */
const THREE: HoldRow[] = [
  { number: 265, title: "Read the frontier", stage: "build", stage_name: "Migrate" },
  { number: 266, title: "Mark the claim", stage: "critique" },
  { number: 267, title: "Ship the change" },
]

async function picksOn(body: () => Promise<void>) {
  await seedSettings({ developer: true })
  await mountAfk(config, project, body)
}

/** The pills of the pick count, and the one the host's answer says is chosen. */
const pills = () => findAll('[data-afk-picks] [role="radio"]')
const pill = (count: number) => pills().find((one) => one.textContent === String(count)) ?? null
const chosen = () => pills().find((one) => one.getAttribute("aria-checked") === "true") ?? null
const afkWrites = (host: { calls: { method: string; path: string; body: unknown }[] }) =>
  host.calls.filter((call) => call.method === "POST" && call.path.endsWith("/afk"))

test("the Working block lists every task it holds, over the count against its pick count", async () => {
  globalThis.fetch = afkHost({ features: FEATURES, holds: THREE, pickCount: 3 })
    .fetch as unknown as typeof fetch
  await picksOn(async () => {
    const section = find("[data-working]")
    const rows = findAll("[data-hold]")
    assert.deepEqual(
      rows.map((row) => row.getAttribute("data-hold")),
      ["265", "266", "267"],
      "one row per hold, oldest first",
    )
    assert.match(
      rows[0].textContent ?? "",
      /#265\s*Migrate: Read the frontier/,
      "a row names the task's number, title and stage",
    )
    assert.equal(rows[0].getAttribute("data-stage"), "build", "and the stage it reads as")
    assert.match(
      rows[1].textContent ?? "",
      /Critiquing: Mark the claim/,
      "a stage with no name of its own",
    )
    assert.match(rows[2].textContent ?? "", /#267\s*Ship the change/, "a task that isn't staged")
    assert.equal(rows[2].getAttribute("data-stage"), null, "and nothing named for it")
    assert.equal(
      find("[data-holds]")?.textContent,
      "3 of 3 held",
      "the count row over the list, holds against the pick count",
    )
    assert.match(
      section?.textContent ?? "",
      /Working3 of 3 held#265.*#266.*#267/s,
      "the count reads above the rows it counts",
    )
  })
})

test("each row's stage is its own, not the oldest hold's", async () => {
  globalThis.fetch = afkHost({ features: FEATURES, holds: THREE, pickCount: 3 })
    .fetch as unknown as typeof fetch
  await picksOn(async () => {
    assert.equal(find("[data-working]")?.getAttribute("data-stage"), "build", "the oldest hold's")
    assert.deepEqual(
      findAll("[data-hold]").map((row) => row.getAttribute("data-stage")),
      ["build", "critique", null],
      "every hold's own stage, in the order the host lists them",
    )
  })
})

test("the pick count is one write, and the count row reads the host's answer", async () => {
  const host = afkHost({ features: FEATURES, holds: THREE.slice(0, 2), pickCount: 2 })
  globalThis.fetch = host.fetch as unknown as typeof fetch
  await picksOn(async () => {
    assert.equal(chosen()?.textContent, "2", "the count the host holds")
    assert.deepEqual(
      pills().map((one) => one.textContent),
      ["1", "2", "3", "4", "5"],
      "one to five, the host's own range",
    )
    assert.equal(find("[data-holds]")?.textContent, "2 of 2 held", "both places taken")

    await click(pill(3))
    assert.deepEqual(
      afkWrites(host).map((call) => call.body),
      [{ pick_count: 3 }],
      "one write, naming the count alone",
    )
    assert.equal(chosen()?.textContent, "3", "the row reads the count the host answered")
    assert.equal(
      find("[data-holds]")?.textContent,
      "2 of 3 held",
      "and the count row counts against it",
    )
  })
})

test("the pick count says what it counts, over the control it sets", async () => {
  globalThis.fetch = afkHost({ features: FEATURES, holds: THREE, pickCount: 3 })
    .fetch as unknown as typeof fetch
  await picksOn(async () => {
    const block = find("[data-afk-picks]")
    assert.ok(block, "the pick count is drawn")
    const line = block.querySelector("p")
    assert.ok(line, "with a line saying what it counts")
    assert.equal(
      line.textContent?.trim(),
      "How many tasks this project's AFK holds at once",
      "the line under the heading, verbatim",
    )
    const group = find('[data-afk-picks] [role="radiogroup"]')
    assert.ok(group, "the control it sets")
    assert.equal(group.getAttribute("aria-label"), "Pick count", "the control keeps its name")
    // Node.DOCUMENT_POSITION_FOLLOWING: the control comes after the line, not over it.
    assert.equal(
      (line.compareDocumentPosition(group) & 4) === 4,
      true,
      "the line sits above the pills",
    )
  })
})

test("the count the row already holds is not a write", async () => {
  const host = afkHost({ features: FEATURES, holds: THREE, pickCount: 4 })
  globalThis.fetch = host.fetch as unknown as typeof fetch
  await picksOn(async () => {
    await click(pill(4))
    assert.equal(afkWrites(host).length, 0, "nothing is written for the count it already has")
  })
})

test("a write the host refuses leaves the count it had", async () => {
  const host = afkHost({
    features: FEATURES,
    holds: THREE.slice(0, 2),
    pickCount: 2,
    pickRefusal: "pick_count must be a whole number from 1 to 5.",
  })
  globalThis.fetch = host.fetch as unknown as typeof fetch
  await picksOn(async () => {
    await click(pill(5))
    assert.equal(afkWrites(host).length, 1, "the write was made")
    assert.equal(chosen()?.textContent, "2", "and the count the host still holds is what shows")
    assert.equal(
      find("[data-holds]")?.textContent,
      "2 of 2 held",
      "the count row is the host's too",
    )
  })
})

test("a plugin without afk_picks draws the sheet it always drew", async () => {
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = new URL(String(input))
    if (url.pathname.endsWith("/plugins/memento/info"))
      return json({ name: "memento", features: ["afk", "afk_switch", "afk_prompt"] })
    if (url.pathname.endsWith("/plugins/memento/skills")) return json({ object: "list", data: [] })
    if (url.pathname.endsWith("/afk"))
      return json({
        object: "memento.afk",
        on: true,
        reason: null,
        task: { repo: "owner/repo", number: 338, title: "Pick a workflow", url: "https://x/338" },
        refusal: null,
        stage: "build",
        stage_name: "Build",
        prompt: "Work in checkpoints.",
      })
    if (url.pathname.endsWith("/tasks"))
      return json({ repos: [], ready: [], claimed: [], blocked: [] })
    return json({ error: { message: `No route for ${url.pathname}` } }, 404)
  }) as unknown as typeof fetch
  await seedSettings({ developer: true })
  await mountAfk(connection("before-picks"), project, async () => {
    // Booleans, not nodes: a failing assertion must not print a whole DOM tree.
    assert.equal(findAll("[data-hold]").length, 0, "no per-hold rows")
    assert.equal(Boolean(find("[data-holds]")), false, "no count row")
    assert.equal(Boolean(find("[data-afk-picks]")), false, "no pick count")
    assert.match(
      find("[data-working]")?.textContent ?? "",
      /Build: Pick a workflow/,
      "the one Working row it has always drawn, from the task the read names",
    )
  })
})

test("a host that holds no list keeps the one Working row from its task", async () => {
  // afk_picks advertised, no holds answered: the read still names a task, and one row is what the
  // sheet draws from it rather than nothing at all.
  globalThis.fetch = afkHost({ features: FEATURES, pickCount: 3 }).fetch as unknown as typeof fetch
  await picksOn(async () => {
    assert.equal(findAll("[data-hold]").length, 0, "no per-hold rows")
    assert.equal(Boolean(find("[data-holds]")), false, "no count row")
    assert.match(
      find("[data-working]")?.textContent ?? "",
      /Build: Pick a workflow/,
      "the one Working row, drawn from the task",
    )
    assert.equal(chosen()?.textContent, "3", "the pick count is still there to set")
  })
})

test("the pop-up draws the pick count and no budget line, whatever the bot answers", async () => {
  globalThis.fetch = afkHost({
    features: FEATURES,
    holds: THREE,
    pickCount: 3,
    pickBudget: 5,
    holdsHeld: 3,
  }).fetch as unknown as typeof fetch
  await picksOn(async () => {
    assert.equal(find("[data-afk-budget]"), null, "the usage line is cut from the sheet")
    assert.equal(find("[data-holds-held]"), null, "and its numbers with it")
    assert.equal(chosen()?.textContent, "3", "the project's own count is what the row draws")
    assert.equal(
      find("[data-holds]")?.textContent ?? null,
      "3 of 3 held",
      "the count row under it still counts the holds",
    )
  })
})

test("a host that answers no count draws no pick count row, whatever budget it answers", async () => {
  globalThis.fetch = afkHost({ features: FEATURES, holds: THREE, pickBudget: 5, holdsHeld: 2 })
    .fetch as unknown as typeof fetch
  await picksOn(async () => {
    assert.equal(find("[data-afk-picks]"), null, "no count to draw")
    assert.equal(find("[data-afk-budget]"), null, "and no budget line in its place")
    assert.equal(
      find("[data-holds]")?.textContent ?? null,
      null,
      "nor a count row with nothing to count against",
    )
    assert.equal(findAll("[data-hold]").length, 3, "the holds themselves are still named")
  })
})

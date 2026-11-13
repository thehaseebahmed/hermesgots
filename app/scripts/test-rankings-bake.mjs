/**
 * The payload the picker's scores ship with (`scripts/build-rankings.mjs`).
 *
 * Three things are pinned, because each is a way the payload can be wrong and look right: the pages
 * of BenchLM's surface merge until one comes back short (so a build ships every ranked model, not
 * the first hundred), a surface without an `items` array is refused and leaves the committed file
 * exactly as it was (so a bad answer never replaces a good payload), and the file the script writes
 * is a module `overallScoreOf` scores from — the one the app imports.
 */
import assert from "node:assert/strict"
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import test from "node:test"
import { fileURLToPath, pathToFileURL } from "node:url"

import {
  BENCHLM_URL,
  DATA,
  PAGE_SIZE,
  fetchAllRankings,
  moduleText,
  writeRankings,
} from "./build-rankings.mjs"
import { scoreFor, scoreMapOf } from "../src/lib/model-match.ts"

const here = path.dirname(fileURLToPath(import.meta.url))

/** Rows shaped like BenchLM's: a `modelKey` and a score. */
const rows = (count, offset) =>
  Array.from({ length: count }, (_, index) => ({
    modelKey: `model-${offset + index}`,
    score: offset + index,
  }))

/** A fetch that answers the pages it is given, recording each call. */
function paged(pages) {
  const calls = []
  const fetchImpl = async (url, init) => {
    calls.push({ url, headers: init?.headers })
    const page = pages[calls.length - 1]
    if (!page) throw new Error(`unexpected page ${calls.length}`)
    return { ok: true, status: 200, json: async () => page }
  }
  return { calls, fetchImpl }
}

test("pages merge until one comes back short", async () => {
  // ~220 rows on the overall surface, a hundred a page: the last page is the short one.
  const { calls, fetchImpl } = paged([
    { surface: "overall", items: rows(PAGE_SIZE, 0) },
    { surface: "overall", items: rows(PAGE_SIZE, 100) },
    { surface: "overall", items: rows(20, 200) },
  ])
  const payload = await fetchAllRankings({ key: "test-key", fetchImpl })

  assert.equal(payload.items.length, 220, "every page's rows are in the payload")
  assert.equal(payload.items[219].modelKey, "model-219", "in the order BenchLM answered them")
  assert.equal(payload.surface, "overall", "the first page's envelope is kept")
  assert.deepEqual(
    calls.map((call) => new URL(call.url).searchParams.get("offset")),
    ["0", "100", "200"],
    "the next offset is asked for until a page comes back short",
  )
  assert.equal(new URL(calls[0].url).searchParams.get("limit"), String(PAGE_SIZE))
  assert.ok(calls[0].url.startsWith(BENCHLM_URL), "the surface is BenchLM's own")
  assert.equal(calls[0].headers.Authorization, "Bearer test-key")
})

test("a payload without an items array is refused and writes nothing", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "rankings-bake-"))
  try {
    const kept = path.join(dir, "kept.ts")
    writeFileSync(kept, "// the payload the last good answer wrote\n", "utf8")
    assert.throws(() => writeRankings({ dataAsOf: "2026-11-13" }, kept), /items/)
    assert.equal(
      readFileSync(kept, "utf8"),
      "// the payload the last good answer wrote\n",
      "a surface with no items array leaves the committed payload alone",
    )

    const absent = path.join(dir, "absent.ts")
    assert.throws(() => writeRankings({ items: "every model" }, absent), /items/)
    assert.equal(existsSync(absent), false, "and writes no file where there was none")
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("the file it writes is the one overallScoreOf scores from", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "rankings-bake-"))
  try {
    // The writer's own text, loaded as a module: a TS module, since the tsconfigs resolve no JSON.
    const written = path.join(dir, "rankings-data.ts")
    writeRankings({ items: [{ modelKey: "gpt-oss-20b", score: 18.17 }] }, written)
    const module = await import(pathToFileURL(written).href)
    assert.equal(
      scoreFor(scoreMapOf(module.RANKINGS.items), "gpt-oss:20b"),
      18.17,
      "the module's rows are the ones a score is looked up in",
    )
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }

  const committed = await import(pathToFileURL(DATA).href)
  assert.ok(
    Array.isArray(committed.RANKINGS.items) && committed.RANKINGS.items.length > 0,
    "the committed payload carries rows",
  )
  assert.equal(
    readFileSync(DATA, "utf8"),
    moduleText(committed.RANKINGS),
    "the committed file is exactly what the script writes for its own payload",
  )
  // The module the picker scores through, over a row the committed payload really carries.
  const { overallScoreOf } = await import(
    pathToFileURL(path.join(here, "../src/lib/rankings.ts")).href
  )
  const [ranked] = committed.RANKINGS.items
  assert.equal(
    overallScoreOf({ model: ranked.modelKey }),
    ranked.score,
    "and overallScoreOf scores the payload's own row",
  )
})

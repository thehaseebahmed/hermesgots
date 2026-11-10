/**
 * Linking a bot reads its settings pages once and keeps the answers (ADR 0132), so the first open of
 * each draws values; a page the host can't answer is left to its own first open.
 */
import assert from "node:assert/strict"
import test from "node:test"

import { db } from "@/lib/db"
import { warmBotSettings } from "@/lib/host-warm"
import { GENERAL, json, seedSettings, until } from "./component-kit.tsx"

const SERVER = { baseUrl: "http://warm.test/v1", apiKey: "warm-key" }

test("a linked bot's pages are read once and kept, and a refused page doesn't stop the rest", async () => {
  await seedSettings()
  const asked: string[] = []
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const path = new URL(String(input)).pathname
    asked.push(path)
    if (path.endsWith("/plugins/gots/info"))
      return json({ name: "gots", features: ["general_page", "mcps", "fallbacks"] })
    if (path.endsWith("/plugins/gots/general"))
      return json({ object: "gots.general", general: GENERAL })
    if (path.endsWith("/plugins/gots/mcp")) return json({ object: { servers: [] } })
    if (path.endsWith("/plugins/gots/fallbacks")) return json({ fallbacks: [] })
    return json({ error: { message: "Not Found" } }, 404)
  }) as typeof fetch
  await warmBotSettings(SERVER)
  const keptRoutes = async () =>
    (await db.hostCache.toArray())
      .filter((row) => row.key.includes("warm-key"))
      .map((row) => row.key.split("\n").pop())
  await until(async () => (await keptRoutes()).includes("info"), "the features kept")
  const kept = await keptRoutes()
  for (const route of ["general", "mcp", "info"])
    assert.ok(kept.includes(route), `${route} kept, got ${kept}`)
})

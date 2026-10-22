/**
 * The plugin was called memento before it was Gots. A host that hasn't updated has no route at the
 * new name; the app asks the old name's `info` and uses the old routes only if it answers as the
 * old plugin, and never sends a request twice to a host that really is the new plugin.
 */
import assert from "node:assert/strict"
import test from "node:test"

import { getPluginFeatures } from "@/lib/hermes"

import { json } from "./component-kit.tsx"

type Config = Parameters<typeof getPluginFeatures>[0]

const config = (port: number) => ({ baseUrl: `http://host${port}.test/v1`, apiKey: "k" }) as Config

function host(old: "old" | "new" | "down") {
  const asked: string[] = []
  const fetch = async (input: RequestInfo | URL) => {
    const path = new URL(String(input)).pathname
    asked.push(path)
    if (old === "down") throw new TypeError("Failed to fetch")
    if (path.startsWith("/api/plugins/gots/"))
      return old === "new" ? json({ name: "gots", features: ["skills"] }) : json({}, 404)
    // The release that renames also answers at the old prefix, as the old plugin did.
    return json({ name: old === "old" ? "memento" : "gots", features: ["skills"] })
  }
  return { asked, fetch }
}

test("a host that answers only at the old name is asked there from then on", async () => {
  const { asked, fetch } = host("old")
  globalThis.fetch = fetch as typeof globalThis.fetch
  assert.deepEqual(await getPluginFeatures(config(1)), ["skills"])
  asked.length = 0
  await getPluginFeatures(config(1))
  assert.deepEqual(asked, ["/api/plugins/memento/info"])
})

test("a host that is the new plugin is never asked at the old name", async () => {
  const { asked, fetch } = host("new")
  globalThis.fetch = fetch as typeof globalThis.fetch
  await getPluginFeatures(config(2))
  assert.deepEqual(asked, ["/api/plugins/gots/info"])
})

test("a host that is away fails once and is not taken for an old plugin", async () => {
  const { fetch } = host("down")
  globalThis.fetch = fetch as typeof globalThis.fetch
  await assert.rejects(getPluginFeatures(config(3)))
  const back = host("new")
  globalThis.fetch = back.fetch as typeof globalThis.fetch
  await getPluginFeatures(config(3))
  assert.deepEqual(back.asked, ["/api/plugins/gots/info"])
})

test("a host that updates drops the old-name fallback", async () => {
  globalThis.fetch = host("old").fetch as typeof globalThis.fetch
  await getPluginFeatures(config(4))
  const updated = host("new")
  globalThis.fetch = updated.fetch as typeof globalThis.fetch
  await getPluginFeatures(config(4)) // still asked at the old name, which now answers as gots
  await getPluginFeatures(config(4))
  assert.deepEqual(updated.asked.at(-1), "/api/plugins/gots/info")
})

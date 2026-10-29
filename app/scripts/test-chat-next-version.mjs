/** The Hermes the new chat screen works with: 0.22.5 and newer, which the plugin asks for. */
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import test from "node:test"

import { MIN_HERMES } from "../src/chat-next/api.ts"

test("the oldest Hermes it works with is the one that shares a run's events", () => {
  assert.equal(MIN_HERMES, "0.22.5")
})

test("the plugin asks Hermes for the same floor, so it never loads where the chat can't run", () => {
  const manifest = readFileSync(new URL("../../plugin/plugin.yaml", import.meta.url), "utf8")
  assert.equal(/^requires_hermes:\s*"([^"]*)"/m.exec(manifest)?.[1], `>=${MIN_HERMES}`)
})

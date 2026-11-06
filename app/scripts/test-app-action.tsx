/**
 * A page's write, as the Tasks app makes it: the Button runs a mutation, shows pending until the
 * tool answers, and goes back to what it was when the tool refuses. Nothing flips before the answer.
 */
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { dirname, join } from "node:path"
import test from "node:test"
import { fileURLToPath } from "node:url"

import type { McpClientLike } from "@openuidev/react-lang"

import OpenUIBlock from "@/components/openui/openui-block"

import { click, findAll, mount, settle, wordsOf } from "./component-kit.tsx"

const ROOT = readFileSync(
  join(
    dirname(fileURLToPath(import.meta.url)),
    "..",
    "..",
    "plugin",
    "openui",
    "apps",
    "gtd",
    "root.txt",
  ),
  "utf8",
)

function tasks(answer: Promise<unknown>) {
  const calls: { name: string; arguments?: Record<string, unknown> }[] = []
  const provider: McpClientLike = {
    async callTool(call) {
      calls.push(call)
      if (call.name === "todoist.complete-task") return answer as never
      throw new Error("no answer")
    },
  }
  return { calls, provider }
}

const complete = () =>
  findAll("button").find((one) => wordsOf(one).startsWith("Complete")) as HTMLButtonElement

async function open(provider: McpClientLike, body: () => Promise<void>) {
  await mount(
    <OpenUIBlock
      app
      source={ROOT}
      open={false}
      streaming={false}
      draw="interface"
      tools={provider}
    />,
    body,
  )
}

test("completing a task is pending until the answer lands", async () => {
  let land: (value: unknown) => void = () => {}
  const { calls, provider } = tasks(new Promise((resolve) => (land = resolve)))
  await open(provider, async () => {
    assert.equal(complete().disabled, false)
    await click(complete())
    assert.equal(complete().disabled, true, "pending while the tool has not answered")
    assert.equal(calls.filter((call) => call.name === "todoist.complete-task").length, 1)
    land({ content: [], structuredContent: {} })
    await settle()
    assert.equal(complete().disabled, false, "settled once the answer landed")
  })
})

test("a refused completion returns the button to its previous state", async () => {
  let refuse: (reason: unknown) => void = () => {}
  const { provider } = tasks(new Promise((_, reject) => (refuse = reject)))
  await open(provider, async () => {
    const before = wordsOf(complete())
    await click(complete())
    assert.equal(complete().disabled, true)
    refuse(new Error("Todoist refused"))
    await settle()
    assert.equal(complete().disabled, false)
    assert.equal(wordsOf(complete()), before)
  })
})

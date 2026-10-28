/**
 * The running turn's reply, read from the transcript, when that turn is the wake run a finished
 * subagent starts. The run has no user message of its own, so it is asked for by when it began: the
 * answer must be the wake reply, not the reply the previous turn already finished — which the chat
 * would draw a second time, whole, under it.
 */
import assert from "node:assert/strict"
import test from "node:test"

import { liveTurn } from "@/lib/history"
import { isWakePrompt } from "@/lib/wake-prompt"
import type { SessionMessage } from "@/lib/hermes"
import { connection, serveTranscript, transcriptRows, wakePromptText } from "./component-kit.tsx"

const server = connection("wake-live")
const REQUEST = "Do it"

const { row, pair, reset } = transcriptRows()

/**
 * The reply the live read gives for the run that opens at `opener` (REQUEST, else the wake prompt)
 * over rows built from a fresh numbering.
 */
async function replyOf(build: () => SessionMessage[], opener: "request" | "wake" = "request") {
  reset()
  const rows = build()
  serveTranscript(rows)
  const at = rows.find((one) =>
    opener === "wake" ? isWakePrompt(one) : one.content === REQUEST,
  )!.timestamp!
  return liveTurn(server, "s", at)
}

const wakePrompt = () => row("user", wakePromptText())

test("a wake run's reply is read as its own, not as the turn before it", async () => {
  const reply = await replyOf(
    () => [
      row("user", REQUEST),
      ...pair("terminal", "Pass one is applied"),
      row("assistant", "Waiting on the subagent."),
      wakePrompt(),
      ...pair("patch", "The finding changes the plan"),
    ],
    "wake",
  )
  assert.equal(reply?.content, "The finding changes the plan")
  assert.deepEqual(
    reply?.tools?.map((tool) => tool.tool),
    ["patch"],
    "only the wake run's own calls",
  )
})

test("a wake run with nothing written yet reads as nothing, not as the turn before it", async () => {
  const reply = await replyOf(
    () => [row("user", REQUEST), ...pair("terminal", "Pass one is applied"), wakePrompt()],
    "wake",
  )
  assert.equal(reply, undefined)
})

test("a turn the user started is still its own reply, wake runs before it left alone", async () => {
  const reply = await replyOf(() => [
    row("user", "Earlier ask"),
    ...pair("terminal", "Earlier work"),
    wakePrompt(),
    ...pair("patch", "Wake work"),
    row("user", REQUEST),
    ...pair("terminal", "This turn's work"),
  ])
  assert.equal(reply?.content, "This turn's work")
})

test("a later turn of another device does not become this turn's reply", async () => {
  const reply = await replyOf(() => [
    row("user", REQUEST),
    ...pair("terminal", "This turn's work"),
    row("user", "Sent from another device"),
    ...pair("patch", "That turn's work"),
  ])
  assert.equal(reply?.content, "This turn's work")
})

test("a turn with no reply written yet reads as nothing, not as the next turn's reply", async () => {
  const reply = await replyOf(() => [
    row("user", REQUEST),
    row("user", "Sent from another device"),
    ...pair("patch", "That turn's work"),
  ])
  assert.equal(reply, undefined)
})

test("a turn that began just before the run is not taken for it", async () => {
  reset()
  const rows = [
    row("user", "Earlier ask"),
    ...pair("terminal", "Earlier work"),
    row("user", REQUEST),
  ]
  rows.push(...pair("patch", "This turn's work"))
  serveTranscript(rows)
  const at = rows.find((one) => one.content === REQUEST)!.timestamp!
  const reply = await liveTurn(server, "s", at)
  assert.equal(reply?.content, "This turn's work")
})

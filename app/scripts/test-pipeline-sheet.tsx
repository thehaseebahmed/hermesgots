/**
 * The pipeline's own screen, drawn from a snapshot: one bar per stage of the workflow the task ran,
 * and under each stage what it ran — the gate's commands with their exit codes — and what its review
 * found, counted against the skill that raised it and opening to the list.
 */
import assert from "node:assert/strict"
import test from "node:test"
import { act } from "react"
import { createRoot } from "react-dom/client"

import { PipelinePill, PipelineSheet } from "@/components/chat/pipeline"
import { parsePipeline } from "@/lib/pipeline"

const snapshot = {
  workflow: { id: "preset:staged", name: "Build · Test · Review · Summary" },
  stage: 2,
  round: 1,
  stages: [
    {
      name: "Build",
      steps: [],
      check: null,
      loop: null,
      ships: false,
      state: "done",
      rounds: [
        {
          run_id: "run-1",
          commands: [{ command: "pnpm lint", repo: null, code: 0 }],
          gate: [],
          findings: [],
          stop: null,
          retry: null,
        },
      ],
    },
    {
      name: "Test",
      steps: [],
      check: "gate",
      loop: null,
      ships: false,
      state: "done",
      rounds: [
        {
          run_id: "run-2",
          commands: [],
          gate: { commands: [{ command: "pnpm test", repo: null, code: 1 }] },
          findings: [],
          stop: null,
          retry: null,
        },
      ],
    },
    {
      name: "Review",
      steps: ["code-review"],
      check: null,
      loop: null,
      ships: true,
      state: "failed",
      rounds: [
        {
          run_id: "run-3",
          commands: [],
          gate: [],
          findings: [
            {
              skill: "code-review",
              findings: [
                { title: "The sheet forgets the workflow", detail: "It reads the record twice." },
                { title: "A stage has no name", detail: null },
              ],
            },
          ],
          stop: "The review found two things to fix.",
          retry: null,
        },
      ],
    },
    { name: "Summary", steps: [], check: null, loop: null, ships: false, state: "todo", rounds: [] },
  ],
}

async function mount(element: React.ReactNode) {
  const container = document.createElement("div")
  document.body.append(container)
  const root = createRoot(container)
  await act(async () => root.render(element))
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0))
  })
  return {
    container,
    close: async () => {
      await act(async () => root.unmount())
      container.remove()
    },
  }
}

const findAll = (selector: string) => [...document.querySelectorAll(selector)]

test("the sheet draws one row per stage of the workflow the task ran", async () => {
  const pipeline = parsePipeline(snapshot)
  assert.ok(pipeline)
  const sheet = await mount(
    <PipelineSheet open onOpenChange={() => {}} pipeline={pipeline} prLabel="PR #27" />,
  )
  try {
    const text = document.body.textContent ?? ""
    assert.match(text, /AFK - Stage 3 of 4/, "the title counts the workflow's stages")
    assert.deepEqual(
      findAll("ol > li").map((row) => row.getAttribute("data-stage")),
      ["Build", "Test", "Review", "Summary"],
      "four stages, in the workflow's order and its own words",
    )
    assert.match(text, /pnpm lint/, "the build's own command")
    assert.match(text, /pnpm test/, "the gate's")
    assert.match(text, /exit 1/, "with the code the gate answered")
    const findings = document.querySelector("[data-findings]")
    assert.equal(findings?.textContent, "code-review2 findings", "the skill and what it found")
    assert.match(text, /The review found two things to fix\./)
  } finally {
    await sheet.close()
  }
})

test("a review's findings open to the list it found", async () => {
  const pipeline = parsePipeline(snapshot)
  assert.ok(pipeline)
  const sheet = await mount(<PipelineSheet open onOpenChange={() => {}} pipeline={pipeline} />)
  try {
    const count = document.querySelector("[data-findings] button")
    assert.equal(count?.getAttribute("aria-expanded"), "false")
    await act(async () => {
      count?.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }))
    })
    const text = document.body.textContent ?? ""
    assert.match(text, /The sheet forgets the workflow/, "one finding's title")
    assert.match(text, /It reads the record twice\./, "and what it said")
    assert.match(text, /A stage has no name/, "a finding with nothing said under it")
  } finally {
    await sheet.close()
  }
})

test("the pill draws a bar per stage of the snapshot", async () => {
  const pipeline = parsePipeline(snapshot)
  assert.ok(pipeline)
  const pill = await mount(<PipelinePill pipeline={pipeline} onClick={() => {}} />)
  try {
    assert.equal(findAll("[data-pipeline] [data-step]").length, 4, "four bars")
    const label = document.querySelector("[data-pipeline]")?.getAttribute("aria-label") ?? ""
    assert.match(label, /Review/, "and the stage it is in")
    for (const word of ["Build", "Test", "Review", "Summary"]) assert.match(label, new RegExp(word))
  } finally {
    await pill.close()
  }
})

/**
 * A Code row drawn over the device's own database: which colour its round icon wears, which glyph
 * says why, and the unread dot, as the mark CodeList threads from this device's read marks decides
 * — the components' own answers, with the session's claim computed from faked host facts the way
 * CodeList computes it. Geometry (where the dot sits) is the browser flow's (`e2e/code-list.mjs`),
 * since a DOM without layout has no boxes; the pure rules behind all of this are unit tests
 * (`test-session-work.mjs`).
 */
import assert from "node:assert/strict"
import test from "node:test"
import { MemoryRouter } from "react-router"

import { markRead } from "@/lib/read-marks"
import type { Conversation } from "@/lib/db"
import { db } from "@/lib/db"
import { SessionItem } from "@/routes/code"
import { sessionGroup, type LiveTurn, type LocalTurn } from "@/lib/session-work"
import { mount, seedSettings } from "./component-kit.tsx"
import { pr } from "./fixtures/pr.ts"

const conversation = (id: string, patch: Partial<Conversation> = {}): Conversation => ({
  id,
  profileId: "bot-1",
  title: `Session ${id}`,
  hermesSessionId: `${id}-hermes`,
  createdAt: 100,
  updatedAt: 200,
  changedAt: 200,
  ...patch,
})

/** Draws one row the way CodeList does: host facts in, the claim computed, the row over the db. */
async function drawRow(
  c: Conversation,
  {
    live,
    local,
    subagents,
    mark,
    body,
  }: {
    live?: LiveTurn
    local?: LocalTurn
    subagents?: number
    mark?: number
    body: () => Promise<void>
  },
) {
  await seedSettings()
  await db.conversations.clear()
  await db.conversations.put(c)
  const claim = sessionGroup(c, live, local, subagents)
  await mount(
    <MemoryRouter>
      <SessionItem
        row={{ c, state: claim.state, prTick: claim.prTick, key: c.id }}
        showProject={false}
        now={1_000}
        mark={mark}
      />
    </MemoryRouter>,
    body,
  )
}

/** The round icon: its span (the tone lives in its classes) and the glyph drawn inside it. */
function icon() {
  const circle = document.querySelector("span.size-10")
  assert.ok(circle, "the row's round icon is drawn")
  const glyph = circle.querySelector("svg")
  return {
    circle: circle as HTMLElement,
    glyphClass: glyph?.getAttribute("class") ?? "",
    loading: glyph?.getAttribute("aria-label") === "Loading",
    tone: [...circle.classList],
  }
}

const toneHas = (tone: string[], token: string) =>
  assert.ok(tone.includes(token), `the icon wears ${token}, wears ${tone.join(" ")}`)
const glyphIs = (glyphClass: string, name: string) =>
  assert.ok(glyphClass.includes(name), `the glyph is ${name}, is ${glyphClass || "(none)"}`)

test("the round icon is yellow for a wait, green for done or healthy, grey at rest", async () => {
  const cases: {
    id: string
    patch?: Partial<Conversation>
    live?: LiveTurn
    local?: LocalTurn
    subagents?: number
    tone: string
  }[] = [
    { id: "human", local: { waiting: true }, tone: "bg-warning/15" },
    { id: "checks-run", patch: { prs: [pr("open", "pending")] }, tone: "bg-warning/15" },
    { id: "checks-fail", patch: { prs: [pr("open", "failure")] }, tone: "bg-warning/15" },
    { id: "draft-question", patch: { prs: [pr("draft", "success")] }, local: { waiting: true }, tone: "bg-warning/15" },
    { id: "merge-waits", patch: { prs: [pr("open", "success")] }, tone: "bg-primary/10" },
    { id: "resolved", patch: { resolvedAt: 300, prs: [pr("open", "pending")] }, tone: "bg-primary/10" },
    { id: "discarded", patch: { discardedAt: 300, prs: [pr("open", "success")] }, tone: "bg-muted" },
    { id: "draft-rest", patch: { prs: [pr("draft", "success")] }, tone: "bg-muted" },
    { id: "working", local: { streaming: true }, tone: "bg-muted" },
    { id: "subagents", subagents: 1, tone: "bg-muted" },
    { id: "idle", tone: "bg-muted" },
  ]
  for (const one of cases) {
    await drawRow(conversation(one.id, one.patch), {
      live: one.live,
      local: one.local,
      subagents: one.subagents,
      body: async () => {
        toneHas(icon().tone, one.tone)
      },
    })
  }
})

test("the glyph says why: alert, pull request arrow, spinner, code, check, archive", async () => {
  const cases: {
    id: string
    patch?: Partial<Conversation>
    local?: LocalTurn
    subagents?: number
    glyph: string
    loading?: boolean
  }[] = [
    { id: "g-human", local: { waiting: true }, glyph: "lucide-circle-alert" },
    { id: "g-checks", patch: { prs: [pr("open", "pending")] }, glyph: "lucide-git-pull-request-arrow" },
    { id: "g-merge", patch: { prs: [pr("open", "success")] }, glyph: "lucide-git-pull-request-arrow" },
    { id: "g-draft", patch: { prs: [pr("draft", "success")] }, glyph: "lucide-git-pull-request-arrow" },
    { id: "g-working", local: { streaming: true }, glyph: "lucide", loading: true },
    { id: "g-subagents", subagents: 1, glyph: "lucide", loading: true },
    { id: "g-idle", glyph: "lucide-code-xml" },
    { id: "g-resolved", patch: { resolvedAt: 300 }, glyph: "lucide-check" },
    { id: "g-discarded", patch: { discardedAt: 300 }, glyph: "lucide-archive-x" },
  ]
  for (const one of cases) {
    await drawRow(conversation(one.id, one.patch), {
      local: one.local,
      subagents: one.subagents,
      body: async () => {
        const drawn = icon()
        if (one.loading) assert.ok(drawn.loading, `${one.id}: the spinner keeps its status`)
        else glyphIs(drawn.glyphClass, one.glyph)
      },
    })
  }
})

test("a session this device hasn't read wears the dot, and a read mark clears it", async () => {
  // No mark: never opened on this device. The dot is the blue one, and said in words too.
  await drawRow(conversation("unread"), {
    body: async () => {
      const dot = document.querySelector("[data-unread]")
      assert.ok(dot, "never opened here, so unread")
      const circle = icon().circle
      assert.equal(dot.parentElement, circle.parentElement, "the dot sits on the icon's own wrapper")
      assert.ok([...(dot as HTMLElement).classList].includes("bg-info"), "the dot is the blue one")
      assert.match(document.body.textContent ?? "", /New activity/, "the dot is said in words too")
    },
  })
  // A mark as new as the thread's activity: read, so nothing to say.
  await drawRow(conversation("read"), {
    mark: Date.now(),
    body: async () => {
      assert.equal(document.querySelector("[data-unread]"), null, "read: the dot is gone")
    },
  })
  // A mark older than the thread's activity: the dot comes back.
  await drawRow(conversation("older", { updatedAt: Date.now() }), {
    mark: Date.now() - 60_000,
    body: async () => {
      assert.ok(document.querySelector("[data-unread]"), "activity landed since the mark")
    },
  })
})

test("a closed session with new activity is dotted too", async () => {
  await drawRow(conversation("closed-new", { resolvedAt: 300 }), {
    body: async () => {
      assert.ok(document.querySelector("[data-unread]"), "Resolved still tells this device it is new")
    },
  })
})

test("a mark never moves back, and the oldest drop once the store is full", () => {
  const store = () =>
    JSON.parse(localStorage.getItem("memento:read-marks") ?? "{}") as Record<string, number>
  markRead("mono", 100)
  markRead("mono", 50)
  assert.equal(store()["mono"], 100, "an older moment never moves a mark back")
  for (let i = 0; i < 500; i++) markRead(`bulk-${i}`, 1_000 + i)
  assert.equal(Object.keys(store()).length, 500, "the store holds only its cap")
  assert.equal(store()["mono"], undefined, "the oldest mark drops once it is full")
  assert.ok(store()["bulk-499"], "the newest survive")
})

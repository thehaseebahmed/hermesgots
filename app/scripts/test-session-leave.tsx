/**
 * A project session before it is sent in, on chat-next (ADR 0065) and on the current screen alike:
 * the bot and the repos it will work in said in its place, a way back to Code, and a session left
 * with nothing sent in not kept — deleted, or kept as a draft when something was typed.
 */
import assert from "node:assert/strict"
import test from "node:test"
import { act } from "react"
import { MemoryRouter, Route, Routes } from "react-router"

import { db, type Settings } from "@/lib/db"
import { saveDraft } from "@/lib/drafts"
import { ChatPage } from "@/routes/chat"
import { fakeHost } from "./chat-next-host.ts"
import { botProfile, click, find, mount, Path, path, seedChats, settle } from "./component-kit.tsx"

async function until(check: () => boolean, what: string) {
  const by = Date.now() + 6_000
  while (!check() && Date.now() < by) {
    await settle()
    await act(async () => new Promise((resolve) => setTimeout(resolve, 25)))
  }
  assert.ok(check(), what)
}

const screen = (id: string) => (
  <MemoryRouter initialEntries={[`/c/${id}`]}>
    <Path />
    <Routes>
      <Route path="/c/:id" element={<ChatPage slot="route" />} />
      <Route path="/code" element={<p data-code>Code</p>} />
    </Routes>
  </MemoryRouter>
)

/** A session of a project on chat-next; `sent` says whether anything was sent in it. */
async function seedSession(
  name: string,
  { sent = false, next = true }: { sent?: boolean; next?: boolean } = {},
) {
  const bot = botProfile(name, { baseUrl: `http://${name}.test/v1` })
  const id = `${name}-s1`
  await seedChats([{ id, title: "Draft session", at: 5 }], {
    bots: [bot],
    settings: { chatNext: next } satisfies Partial<Settings>,
  })
  await db.conversations.update(id, {
    projectId: "p1",
    worktree: {
      branch: "hermes/x",
      repos: [{ name: "me/repo", branch: "main" }],
      instructions: "",
    },
    ...(sent ? { updatedAt: 9 } : {}),
  })
  await db.drafts.clear()
  fakeHost(`memento-${id}`, { plugin: true })
  return id
}

const backToCode = () => find('[aria-label="Back to Code"]')

/** Both screens treat a project session the same, so each test runs on both. */
const screens = [
  ["chat-next", true],
  ["the current screen", false],
] as const

for (const [which, next] of screens) {
  test(`a session not started says its repos in its place, with no title on ${which}`, async () => {
    const id = await seedSession(`session-blank-${which}`, { next })
    await mount(screen(id), async () => {
      await until(
        () => Boolean(find("[data-chat-next]")) === next,
        next ? "on chat-next" : "on the current screen",
      )
      await until(
        () => /me\/repo/.test(find('[data-slot="chat-pane"]')?.textContent ?? ""),
        "the repos it will work in",
      )
      assert.equal(find('[data-slot="header-title"]')?.textContent?.trim() ?? "", "")
      assert.ok(backToCode(), "and a way back to Code")
    })
  })

  test(`leaving a session nothing was sent in deletes it on ${which}`, async () => {
    const id = await seedSession(`session-delete-${which}`, { next })
    await mount(screen(id), async () => {
      await until(() => Boolean(backToCode()), "the way back is drawn")
      await click(backToCode())
      await until(() => Boolean(find("[data-code]")), "back at Code")
      assert.equal(await db.conversations.get(id), undefined)
    })
  })

  test(`leaving it with something typed asks, and Save draft keeps it on ${which}`, async () => {
    const id = await seedSession(`session-draft-${which}`, { next })
    await mount(screen(id), async () => {
      await until(() => Boolean(backToCode()), "the way back is drawn")
      saveDraft(`c:${id}`, "Fix the build")
      await click(backToCode())
      await until(() => /Save your draft\?/.test(document.body.textContent ?? ""), "it asks")
      assert.ok(await db.conversations.get(id), "and nothing is deleted while it does")
      const save = [...document.querySelectorAll("button")].find(
        (b) => b.textContent === "Save draft",
      )
      await click(save)
      await until(() => Boolean(find("[data-code]")), "back at Code")
      assert.ok((await db.conversations.get(id))?.draftAt, "kept as a draft")
    })
  })

  test(`a session already sent in leads back to Code and is kept on ${which}`, async () => {
    const id = await seedSession(`session-sent-${which}`, { sent: true, next })
    await mount(screen(id), async () => {
      await until(() => Boolean(backToCode()), "the way back is drawn")
      await click(backToCode())
      await until(() => path() === "/code" || Boolean(find("[data-code]")), "back at Code")
      assert.ok(await db.conversations.get(id), "kept")
    })
  })
}

/**
 * A message's file in the thread, over a seeded device database with the HTTP boundary faked: a
 * file this device doesn't hold draws as a row naming it and its size, and a tap fetches the bytes
 * through the bot's plugin media route — with the key, which a plain link can't carry — and saves
 * them under the file's own name.
 */
import assert from "node:assert/strict"
import test from "node:test"

import type { Attachment, Message } from "@/lib/db"
import {
  botProfile,
  chatScreen,
  click,
  findAll,
  json,
  mount,
  seedChat,
  seedSettings,
  text,
  until,
} from "./component-kit.tsx"

const NAME = "field notes.pdf"
const HOST_PATH = "/home/h/.hermes/memento/attachments/session-1/field notes.pdf"

const attachment: Attachment = {
  id: "a1",
  name: NAME,
  type: "application/pdf",
  size: 2048,
  image: false,
  path: HOST_PATH,
}

const message = (attachments: Attachment[]): Message => ({
  id: "m1",
  conversationId: "c1",
  role: "user",
  content: "here it is",
  status: "done",
  createdAt: 2,
  attachments,
})

/** One host, recording every media read it was sent. */
function host() {
  const reads: { path: string; authorization: string | null }[] = []
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input instanceof Request ? input.url : input))
    if (!url.host.startsWith("attachment-row")) return json({})
    if (url.pathname.endsWith("/plugins/memento/media")) {
      reads.push({
        path: url.searchParams.get("path") ?? "",
        authorization: new Headers(init?.headers).get("authorization"),
      })
      return new Response("bytes", {
        status: 200,
        headers: { "content-type": "application/pdf" },
      })
    }
    return json({})
  }) as typeof fetch
  return reads
}

const row = () =>
  findAll("button").find(
    (button) =>
      button.getAttribute("aria-label") === `Download ${NAME}` ||
      button.getAttribute("aria-label") === `Open ${NAME}`,
  ) ?? null

test("a message's file draws as a row naming it, and a tap saves it under its own name", async () => {
  const profile = botProfile("attachment-row")
  await seedSettings()
  await seedChat({ id: "c1", profile, messages: [message([attachment])] })
  const reads = host()

  // jsdom has no object URLs and no download of its own, so both stand in for the browser's effect.
  const saved: string[] = []
  const anchor = window.HTMLAnchorElement.prototype
  const real = {
    create: URL.createObjectURL,
    revoke: URL.revokeObjectURL,
    click: anchor.click,
  }
  URL.createObjectURL = () => "blob:field-notes"
  URL.revokeObjectURL = () => {}
  anchor.click = function (this: HTMLAnchorElement) {
    saved.push(this.download)
  }
  try {
    await mount(chatScreen("c1"), async () => {
      await until(async () => row() !== null, "the file's row")
      assert.match(text(), /field notes\.pdf/, "the row names the file")
      assert.match(text(), /2 KB/, "with the size the message stored")
      await click(row())
      await until(async () => saved.length > 0, "the download")
      assert.deepEqual(saved, [NAME], "the browser is told the file's own name")
      assert.deepEqual(
        reads,
        [{ path: HOST_PATH, authorization: "Bearer test-key" }],
        "the bytes come from the media route, behind the bot's key",
      )
    })
  } finally {
    URL.createObjectURL = real.create
    URL.revokeObjectURL = real.revoke
    anchor.click = real.click
  }
})

test("a file the host never took is drawn, and nothing promises a download", async () => {
  const profile = botProfile("attachment-row")
  await seedSettings()
  await seedChat({
    id: "c1",
    profile,
    messages: [message([{ ...attachment, path: undefined }])],
  })
  host()
  await mount(chatScreen("c1"), async () => {
    await until(async () => text().includes(NAME), "the file's name")
    assert.equal(row(), null, "a file with no bytes anywhere has nothing to open")
  })
})

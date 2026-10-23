/**
 * The fixtures both interface tests stand on: a reply's block, the rows of a thread with the code
 * or card in them, and the lazy chunks warmed first so an assertion is about the gate rather than
 * a chunk that hasn't landed. Not a test file: a test file imported by another runs its tests twice.
 */
import type { Message } from "@/lib/db"

import { findAll, settle, until } from "./component-kit.tsx"

export const SALES = [
  "# id: sales",
  "root = Stack([c])",
  'c = Card("Quarterly sales", "Up 12%.")',
].join("\n")

export const block = (body: string) => ["```openui-lang", body, "```"].join("\n")

export const ask = (content: string): Message => ({
  id: "ask",
  conversationId: "",
  role: "user",
  content,
  status: "done",
  createdAt: 1,
})

export const reply = (id: string, content: string, extra: Partial<Message> = {}): Message => ({
  id,
  conversationId: "",
  role: "assistant",
  content,
  status: "done",
  createdAt: 2,
  ...extra,
})

export const rows = () => findAll("[data-slot=message]")
export const replyRow = (needle: string) =>
  rows().find(
    (row) => row.getAttribute("data-align") === "start" && row.textContent?.includes(needle),
  )
export const codeOf = (row: Element | undefined) => row?.querySelector("div[data-md-code]")
export const cardOf = (row: Element | undefined) => row?.querySelector("[data-slot=card]")
export const labelOf = (code: Element) => code.querySelector("span")?.textContent

/** Waits for a drawing that happens a commit after the read it depends on. */
export async function drawn(check: () => boolean, what: string) {
  await until(async () => {
    await settle()
    return check()
  }, what)
}

export async function warm() {
  await import("@/lib/openui-thread.ts")
  await import("@/components/openui/openui-block")
  await import("@/components/chat/markdown-renderer")
}

/**
 * A chat whose archived rows are already on the device draws as one conversation: every turn in
 * order, the compaction's divider between the turns it carried and the row written after it, and no
 * turn twice — the draw side of loading a compacted chat's history (ADR 0058).
 */
import assert from "node:assert/strict"
import test from "node:test"

import { db, type Message } from "@/lib/db"

import { botProfile, chatScreen, mount, seedChat, until } from "./component-kit.tsx"

const CHAT = "archive"
const SECOND = 1_000

/** A stored row of the chat, numbered and timed as the host gave it. */
const row = (id: number, role: "user" | "assistant", content: string, at: number): Message => ({
  id: `h-${CHAT}-hermes-${id}`,
  conversationId: CHAT,
  role,
  content,
  status: "done",
  createdAt: at,
  hermesRowId: id,
  hermesAt: at,
})

test("the archived turns and the live ones draw as one thread, the divider where it happened", async () => {
  const at = (n: number) => 1_700_000_000_000 + n * 60 * SECOND
  await seedChat({
    id: CHAT,
    profile: botProfile("archive"),
    messages: [
      row(10, "user", "the first question", at(1)),
      row(11, "assistant", "the first answer", at(2)),
      row(20, "user", "the carried question", at(3)),
      row(21, "assistant", "the carried answer", at(4)),
      row(30, "user", "the question after", at(5)),
    ],
  })
  // The host compacted between the answer it carried and the question written after it.
  await db.conversations.update(CHAT, { compactions: [{ at: at(4) + 30 * SECOND }] })

  await mount(chatScreen(CHAT), async () => {
    await until(
      async () => /the question after/.test(document.body.textContent ?? ""),
      "the thread to draw",
    )
    const shown = document.body.textContent ?? ""
    for (const line of [
      "the first question",
      "the first answer",
      "the carried question",
      "the carried answer",
      "the question after",
    ])
      assert.equal(shown.split(line).length - 1, 1, `"${line}" draws once`)

    const divider = shown.indexOf("Compaction")
    assert.ok(divider >= 0, "the compaction draws its divider")
    assert.ok(
      divider > shown.indexOf("the carried answer"),
      "the divider stands below the turns the compaction carried",
    )
    assert.ok(
      divider < shown.indexOf("the question after"),
      "and above the row written after it",
    )
  })
})

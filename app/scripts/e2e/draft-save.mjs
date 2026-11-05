// A live composer's text stays on the device that typed it, and a draft the user *saves* — the
// moment they move out of a session that never started — is the exception: its text rides the chat
// record the Gots plugin holds, so another device (or a reinstall) picks the draft up. A picked
// mode still travels the record too.
import { app, assert, flow, mock, pass } from "./lib.mjs"

const chat = "e2e-draft-save"
const PROJECT = "p_1a2b3c4d"
const TYPED = "half-written thought"

/** The chat record the plugin holds for this chat, as the app pushed it. */
async function record() {
  const body = await fetch(`${mock}/api/plugins/memento/chats`).then((res) => res.json())
  return body.chats?.[chat]?.value ?? null
}

await flow(
  "draft-save",
  async ({ page, seed, until, shot }) => {
    // Equal clocks are what `isUnsent` reads: nothing was ever sent in this session.
    await seed([
      {
        id: chat,
        title: "Draft save",
        projectId: PROJECT,
        draftAt: undefined,
        createdAt: 1,
        updatedAt: 1,
      },
    ])
    await page.goto(`${app}/c/${chat}`)
    const composer = page.getByRole("textbox").last()
    const held = () =>
      page.evaluate(async (id) => {
        const { db } = await import("/src/lib/db.ts")
        const { draftKey } = await import("/src/lib/drafts.ts")
        return (await db.drafts.get(draftKey(id)))?.text
      }, chat)
    const changed = () =>
      page.evaluate(async (id) => {
        const { db } = await import("/src/lib/db.ts")
        return (await db.conversations.get(id))?.changedAt
      }, chat)

    const before = await changed()
    await composer.fill(TYPED)
    await until(() => held(), 10_000, "the typed draft to reach this device's draft store")
    assert.equal(
      await changed(),
      before,
      "typing is this device's write only: the chat's change clock stays where it was",
    )
    pass("a typed draft is kept on the device without touching the chat")

    // The pass the pick wakes is the one a live draft would have ridden: the record it pushes is
    // the proof that no text went with it.
    await page.getByRole("button", { name: "Add context" }).click()
    await page.getByRole("radio", { name: /^Plan/ }).click()
    await until(
      async () => (await record())?.mode === "plan",
      20_000,
      "the picked mode to reach the plugin's chat record",
    )
    assert.equal(
      Object.hasOwn((await record()) ?? {}, "draftText"),
      false,
      "a live composer's text is not in the chat record",
    )
    pass("the pick reaches the record, with no live text beside it")

    await page.getByRole("button", { name: "Back to Code" }).click()
    await page.getByRole("button", { name: "Save draft" }).click()
    await until(
      async () => {
        const pushed = await record()
        return pushed?.draftAt && pushed?.draftText === TYPED
      },
      20_000,
      "the saved draft's text to reach the plugin's chat record",
    )
    pass("saving the draft carries its text through the chat record")

    await page.evaluate(async (id) => {
      const { deleteConversation } = await import("/src/lib/db.ts")
      await deleteConversation(id, { remote: true })
    }, chat)
    await page.goto(`${app}/code`)
    await page.evaluate(async () => {
      const { syncNow } = await import("/src/lib/sync.ts")
      await syncNow()
    })
    await page.goto(`${app}/c/${chat}`)
    await composer.waitFor()
    await until(
      async () => (await composer.inputValue()) === TYPED,
      20_000,
      "the saved draft to fill the composer again from the record",
    )
    await shot("saved-draft-restored")
    pass("a saved draft comes back after this device loses its copy")
  },
  { viewport: { width: 390, height: 844 } },
)

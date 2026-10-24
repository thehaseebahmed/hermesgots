/**
 * The account's prompt library inside a project's prompt editor, over a seeded device database and a
 * faked HTTP boundary: the list it draws from what the account saved (and an empty one starting with
 * no presets), saving the words on screen under a name and tags, a pick copying an entry's words in
 * and writing them through the Prompt route the sheet already serves — so the host clears a picked
 * workflow, as it does for any Prompt — the list renaming and rewriting an entry, a delete leaving a
 * tombstone that names the entry for the other devices and touching no project's Prompt; and the
 * editor signed out, which is the textarea it always was.
 */
import assert from "node:assert/strict"
import test from "node:test"
import { useState } from "react"
import { toast } from "sonner"

import { PromptEditor } from "@/components/afk-prompt"
import { db } from "@/lib/db"
import { setProjectAfkPrompt } from "@/lib/hermes"

import {
  DEFAULT_AFK_PROMPT,
  afkHost,
  click,
  find,
  findAll,
  findText,
  mount,
  mountAfk,
  seedPrompts,
  seedSettings,
  settle,
  type,
} from "./component-kit.tsx"

const config = { baseUrl: "http://hermes.test/v1", apiKey: "test-key" }
const project = "project-1"

type Host = ReturnType<typeof afkHost>

const row = () => find("[data-afk-prompt]")
const field = () => find('textarea[aria-label="Prompt"]')
const fieldValue = () => (field() as HTMLTextAreaElement | null)?.value
const list = () => find("[data-prompt-library]")
const entryRows = () => findAll("[data-prompt]")
const writes = (host: Host) =>
  host.calls.filter((call) => call.method === "POST" && call.path.endsWith("/afk"))
const entries = () => db.prompts.toArray()

/**
 * The editor as the sheet draws it: the words are the project's, the write is the AFK route's, and
 * the host's answer comes back as the words the field now holds. `library` is what the sheet passes
 * once the account is signed in with its vault open and the host advertises afk_picks. A pick hands
 * the entry's id over with its words; Done hands the words alone, which detaches the copy.
 */
function Editor({ host, library }: { host: Host; library: boolean }) {
  const [prompt, setPrompt] = useState(DEFAULT_AFK_PROMPT)
  const [open, setOpen] = useState(true)
  const save = async (draft: { text: string; source?: string }) => {
    try {
      setPrompt((await setProjectAfkPrompt(config, project, draft)).prompt)
      return "saved" as const
    } catch {
      return "refused" as const
    }
  }
  return (
    <PromptEditor open={open} onOpenChange={setOpen} prompt={prompt} onSave={save} library={library} />
  )
}

async function editor(host: Host, body: () => Promise<void>, library = true) {
  globalThis.fetch = host.fetch as unknown as typeof fetch
  await mount(<Editor host={host} library={library} />, body)
}

/** A host that mirrors the plugin this change belongs to: the Prompt, and afk_picks beside it. */
const PICKS_FEATURES = ["afk", "afk_switch", "afk_workflows", "afk_pipeline", "afk_prompt", "afk_picks"]

test("the list draws what the account saved, and ships no presets", async () => {
  await seedPrompts([
    { id: "e-one", name: "Zebra pass", tags: ["review", "qa"], body: "# Zebra\n\nRead the diff first." },
    { id: "e-two", name: "Alpha pass", body: "Start with the issue." },
  ])
  await editor(afkHost({ features: PICKS_FEATURES }), async () => {
    await click(findText("button", "Choose from library"))
    assert.ok(list(), "the library opens from the editor's own door")
    assert.equal(entryRows().length, 2, "both entries are there")
    assert.deepEqual(
      entryRows().map((one) => one.getAttribute("data-prompt")),
      ["e-two", "e-one"],
      "read by name, not by when each was written",
    )
    assert.match(
      entryRows()[1].textContent ?? "",
      /Zebra pass[\s\S]*review[\s\S]*qa[\s\S]*Zebra · Read the diff first\./,
      "a row carries its name, its tags and one line of its body",
    )
    assert.doesNotMatch(list()?.textContent ?? "", /Preset/, "nothing in the library is a preset")
  })
})

test("an empty library says so rather than shipping presets", async () => {
  await seedPrompts([])
  await editor(afkHost({ features: PICKS_FEATURES }), async () => {
    await click(findText("button", "Choose from library"))
    assert.match(list()?.textContent ?? "", /No prompts yet\./, "the library starts empty")
    assert.equal(entryRows().length, 0, "and nothing is offered in its place")
  })
})

test("saving keeps the words on screen under a name and tags, and writes no Prompt", async () => {
  await seedPrompts([])
  const host = afkHost({ features: PICKS_FEATURES })
  await editor(host, async () => {
    await click(findText("button", "Save to library"))
    assert.equal(
      (find('textarea[aria-label="Body"]') as HTMLTextAreaElement | null)?.value,
      DEFAULT_AFK_PROMPT,
      "a new entry starts from the words the project holds",
    )
    await type(find('input[aria-label="Name"]'), "Review first")
    await type(find('input[aria-label="Tags"]'), "review, qa, Review")
    await click(findText("[data-prompt-entry] button", "Save"))

    const saved = await entries()
    assert.equal(saved.length, 1, "one entry, in the account's own library")
    assert.equal(saved[0].name, "Review first", "under the name it was given")
    assert.deepEqual(saved[0].tags, ["review", "qa"], "its tags kept once, however they were cased")
    assert.equal(saved[0].body, DEFAULT_AFK_PROMPT, "holding the words it started from")
    assert.ok(saved[0].id.startsWith("e-"), "with an id this device minted, which the document keys by")
    assert.deepEqual(writes(host), [], "saving to the library is not a write to any project")
    assert.equal(find("[data-prompt-entry]"), null, "and the sheet closes on the save")

    await click(findText("button", "Choose from library"))
    assert.match(entryRows()[0].textContent ?? "", /Review first/, "the list shows what was saved")
  })
})

test("picking copies the entry's words in and writes them with their source", async () => {
  const body = "# Review\n\n- Read the issue.\n- Then the diff."
  await seedPrompts([{ id: "e-one", name: "Review first", tags: ["review"], body }])
  const host = afkHost({ features: PICKS_FEATURES })
  await editor(host, async () => {
    assert.equal(host.state().chosen, "preset:staged", "the project runs a workflow before the pick")

    await click(findText("button", "Choose from library"))
    await click(find('button[aria-label="Use Review first"]'))

    assert.deepEqual(
      writes(host).map((call) => call.body),
      [{ prompt: body, prompt_id: "e-one" }],
      "one write, of the entry's own words and the entry they came from, through the route Done writes",
    )
    assert.equal(
      host.state().chosen,
      null,
      "a Prompt clears a picked workflow on the host, and a pick is a Prompt",
    )
    assert.equal(host.state().source, "e-one", "and the copy remembers the entry it came from")
    assert.equal(fieldValue(), body, "and the words are in the field, where they were copied")
    assert.equal(list(), null, "the list closes on the pick")

    await click(findText("button", "Done"))
    assert.equal(writes(host).length, 1, "Done on the copy the host already holds writes nothing")
    assert.equal(field(), null, "and the editor closes")
  })
})

test("the list renames and rewrites an entry, keeping its id", async () => {
  await seedPrompts([{ id: "e-one", name: "Review first", tags: ["review"], body: "# Review" }])
  const host = afkHost({ features: PICKS_FEATURES })
  await editor(host, async () => {
    await click(findText("button", "Choose from library"))
    await click(find('button[aria-label="Edit Review first"]'))

    assert.equal(
      (find('input[aria-label="Name"]') as HTMLInputElement | null)?.value,
      "Review first",
      "the entry's sheet opens on the entry, not on a blank draft",
    )
    await type(find('input[aria-label="Name"]'), "Review the issue")
    await type(find('input[aria-label="Tags"]'), "review, deep")
    await type(find('textarea[aria-label="Body"]'), "# Review\n\nRead it twice.")
    await click(findText("[data-prompt-entry] button", "Save"))

    const saved = await entries()
    assert.equal(saved.length, 1, "an edit is not a second entry")
    assert.equal(saved[0].id, "e-one", "the id the document keys by never moves")
    assert.equal(saved[0].name, "Review the issue", "the new name is the entry's")
    assert.deepEqual(saved[0].tags, ["review", "deep"], "and its tags")
    assert.match(saved[0].body, /Read it twice/, "and its words")
    assert.ok(saved[0].updatedAt > 1, "with the clock the merge reads it by moved on")
    assert.deepEqual(writes(host), [], "renaming a library entry writes no project")

    await click(findText("button", "Choose from library"))
    assert.match(entryRows()[0].textContent ?? "", /Review the issue/, "the list reads the rename")
  })
})

test("deleting an entry tombstones it and leaves every project's Prompt standing", async () => {
  await seedPrompts([
    { id: "e-one", name: "Review first", tags: [], body: "# Review\n\nRead it twice.", updatedAt: 7 },
  ])
  const host = afkHost({ features: PICKS_FEATURES })
  await editor(host, async () => {
    await click(findText("button", "Choose from library"))
    await click(find('button[aria-label="Edit Review first"]'))
    await click(findText("button", "Delete"))
    await settle()
    const confirm = find('[role="alertdialog"]')
    assert.ok(confirm, "a delete asks first")
    await click(findText('[role="alertdialog"] button', "Delete"))

    assert.deepEqual(await entries(), [], "the entry is gone from this device's library")
    const tombstone = await db.tombstones.get("prompt:e-one")
    assert.ok(tombstone, "and its deletion is named for the other devices")
    assert.ok(
      tombstone!.deletedAt > 7,
      "with a clock past the row's, or the merge would keep the entry it deleted",
    )
    assert.deepEqual(writes(host), [], "no project's Prompt is written by a delete")
    assert.equal(
      fieldValue(),
      DEFAULT_AFK_PROMPT,
      "the copy the project holds stands: a pick was a copy, not a pointer",
    )
    assert.equal(find("[data-prompt-entry]"), null, "and the entry sheet closes on the delete")
  })
})

test("an entry deleted on another device is said, not closed over", async () => {
  await seedPrompts([{ id: "e-one", name: "Review first", tags: ["review"], body: "# Review" }])
  const said: unknown[] = []
  const real = toast.error
  toast.error = ((message: unknown) => {
    said.push(message)
    return ""
  }) as typeof toast.error
  try {
    await editor(afkHost({ features: PICKS_FEATURES }), async () => {
      await click(findText("button", "Choose from library"))
      await click(find('button[aria-label="Edit Review first"]'))
      await type(find('textarea[aria-label="Body"]'), "# Review\n\nRead it twice.")
      // The account's other device deleted the entry while this sheet was open on it.
      await db.prompts.delete("e-one")
      await settle()
      await click(findText("[data-prompt-entry] button", "Save"))

      assert.deepEqual(await entries(), [], "nothing was written for an entry that is gone")
      assert.deepEqual(
        said,
        ["That Prompt is gone from the library."],
        "the sheet says why the save did nothing",
      )
      assert.ok(find("[data-prompt-entry]"), "and stays open rather than closing as if it had saved")
      assert.match(
        (find('textarea[aria-label="Body"]') as HTMLTextAreaElement | null)?.value ?? "",
        /Read it twice/,
        "holding the words that were typed",
      )
    })
  } finally {
    toast.error = real
  }
})

test("signed out, the Prompt editor is the textarea it always was", async () => {
  await seedPrompts([{ id: "e-one", name: "Review first", body: "# Review" }])
  const host = afkHost({ features: PICKS_FEATURES })
  globalThis.fetch = host.fetch as unknown as typeof fetch
  await seedSettings({ developer: true })
  await mountAfk(config, project, async () => {
    await click(find('button[aria-label="Prompt"]'))
    assert.equal(
      find("[data-prompt-library-actions]"),
      null,
      "no library without an account signed in with its vault open, whatever the host advertises",
    )
    assert.equal(findText("button", "Choose from library"), null, "and no door to one")
    assert.equal(findText("button", "Save to library"), null)
    assert.equal(fieldValue(), DEFAULT_AFK_PROMPT, "today's field, holding the project's words")

    await type(field(), "# Mine\n\n- Read the issue first.")
    await click(findText("button", "Done"))
    assert.deepEqual(
      writes(host).map((call) => call.body),
      [{ prompt: "# Mine\n\n- Read the issue first." }],
      "and Done still writes the words it always wrote",
    )
  })
})

test("an editor without the library draws no affordances", async () => {
  await seedPrompts([{ id: "e-one", name: "Review first", body: "# Review" }])
  await editor(
    afkHost({ features: PICKS_FEATURES }),
    async () => {
      assert.equal(find("[data-prompt-library-actions]"), null, "no library where it isn't offered")
      assert.equal(findText("button", "Choose from library"), null)
      assert.equal(find('textarea[aria-label="Prompt"]') !== null, true, "the field, and nothing more")
    },
    false,
  )
})

/**
 * A Prompt that came from the account's library, inside the AFK pop-up: an **Update available**
 * label after the row's title where the entry it was copied from has been rewritten since — a label
 * and not a control, so it asks nothing and writes nothing — and the editor's own line offering the
 * entry's newer words, whose button fills the writing surface and whose Done writes the words with
 * their entry beside them, which takes the label with it. A write that can't reach the host is a
 * toast with the label standing, because the copy still isn't the entry's. And the cases that are
 * silent: a copy that still matches its entry, an entry deleted from the library, a host that
 * answers no source at all, and a Prompt typed by hand, whose plain write detaches the copy on the
 * host so the row never calls the user's own words stale.
 */
import assert from "node:assert/strict"
import test from "node:test"
import { toast } from "sonner"

import {
  afkHost,
  click,
  connection,
  find,
  findText,
  mountAfk,
  seedPrompts,
  seedSettings,
  settle,
  type,
} from "./component-kit.tsx"

// A connection of this file's own, so what its plugin answered is not another file's answer.
const server = connection("prompt-source")
const project = "project-1"
/** A host that holds the Prompt and the library beside it, as this change's plugin does. */
const FEATURES = ["afk", "afk_switch", "afk_workflows", "afk_pipeline", "afk_prompt", "afk_picks"]

/** The words a project copied, and the words its entry holds now that it has been rewritten. */
const COPY = "# Review\n\nRead the diff first."
const NOW = "# Review\n\nRead the issue first."
const MINE = "# Mine\n\n- Read the issue.\n- Then the diff."

type Host = ReturnType<typeof afkHost>

const row = () => find("[data-afk-prompt]")
const marker = () => find("[data-afk-prompt-changed]")
const markerText = () => marker()?.textContent?.trim() ?? null
const offer = () => find("[data-prompt-update]")
const field = () => find('textarea[aria-label="Prompt"]') as HTMLTextAreaElement | undefined
const afkWrites = (host: Host) =>
  host.calls.filter((call) => call.method === "POST" && call.path.endsWith("/afk"))

/**
 * The pop-up over a project whose Prompt was copied from the library, with the library offered on
 * this device: the sheet's own door to it is `library`, which an account's sign-in would open.
 */
async function copied(host: Host, body: () => Promise<void>) {
  await seedSettings({ developer: true })
  globalThis.fetch = host.fetch as unknown as typeof fetch
  await mountAfk(server, project, body, { library: true })
}

test("a copy whose entry moved on is labelled, and the editor offers the entry's words", async () => {
  await seedPrompts([{ id: "e-one", name: "Review first", body: NOW }])
  const host = afkHost({ features: FEATURES, prompt: COPY, promptId: "e-one" })
  await copied(host, async () => {
    assert.match(row()?.textContent ?? "", /Read the diff first/, "the row reads the copy it holds")
    assert.equal(
      markerText(),
      "Update available",
      "the entry says other words, so the row labels the copy as one an update is available for",
    )
    assert.notEqual(
      marker()?.tagName,
      "BUTTON",
      "the label is a label: nothing to press beside the row's own tap",
    )

    await click(marker())
    await settle()
    assert.equal(find('[role="alertdialog"]'), null, "pressing the label asks nothing")
    assert.deepEqual(afkWrites(host), [], "and the label writes nothing")

    await click(find('button[aria-label="Prompt"]'))
    await settle()
    assert.ok(offer(), "the editor offers the entry's newer words as a line of its own")
    assert.match(
      offer()?.textContent ?? "",
      /The library's entry has newer words/,
      "the line saying what it holds",
    )
    assert.deepEqual(afkWrites(host), [], "the offer alone writes nothing")
  })
})

test("the offer fills the writing surface, and Done writes the words with their entry", async () => {
  await seedPrompts([{ id: "e-one", name: "Review first", body: NOW }])
  const host = afkHost({ features: FEATURES, prompt: COPY, promptId: "e-one" })
  await copied(host, async () => {
    await click(find('button[aria-label="Prompt"]'))
    await settle()
    await click(findText("[data-prompt-update] button", "Update"))

    assert.equal(field()?.value, NOW, "the field holds the entry's current words")
    assert.equal(offer(), null, "the line is spent once its words are on screen")
    assert.deepEqual(afkWrites(host), [], "filling alone writes nothing — Done does")

    await click(findText("button", "Done"))

    assert.deepEqual(
      afkWrites(host).map((call) => call.body),
      [{ prompt: NOW, prompt_id: "e-one" }],
      "Done writes the entry's current words and its id together, so the copy stands as a copy",
    )
    assert.equal(marker(), null, "the copy is the entry's again, so there is nothing left to say")
    assert.match(
      row()?.textContent ?? "",
      /Read the issue first/,
      "and the row reads what Done wrote",
    )
    assert.equal(host.state().source, "e-one", "the update keeps the source: it is not a hand edit")
  })
})

test("an update the host refuses is a toast, and the label stands", async () => {
  const REFUSAL = "Couldn't reach that bot."
  const said: unknown[] = []
  const real = toast.error
  toast.error = ((message: unknown) => {
    said.push(message)
    return ""
  }) as typeof toast.error
  try {
    await seedPrompts([{ id: "e-one", name: "Review first", body: NOW }])
    const host = afkHost({
      features: FEATURES,
      prompt: COPY,
      promptId: "e-one",
      promptRefusal: REFUSAL,
    })
    await copied(host, async () => {
      await click(find('button[aria-label="Prompt"]'))
      await settle()
      await click(findText("[data-prompt-update] button", "Update"))
      await click(findText("button", "Done"))

      assert.deepEqual(said, [REFUSAL], "the host's own refusal reaches the user as a toast")
      assert.equal(
        markerText(),
        "Update available",
        "nothing was written, so the copy is still not the entry's",
      )
      assert.match(
        row()?.textContent ?? "",
        /Read the diff first/,
        "and the row still reads the copy",
      )
    })
  } finally {
    toast.error = real
  }
})

test("an original, a deleted entry and a host without a source are all unlabelled", async () => {
  // The entry still says exactly what was copied: there is nothing to offer.
  await seedPrompts([{ id: "e-one", name: "Review first", body: NOW }])
  await copied(afkHost({ features: FEATURES, prompt: NOW, promptId: "e-one" }), async () => {
    assert.match(row()?.textContent ?? "", /Read the issue first/, "the copy the project holds")
    assert.equal(marker(), null, "the same words in both is no change to say")
  })

  // The entry was saved with a trailing newline, and the host trimmed what it was given: a pick of
  // it lands without the ends, and that is still its copy — not a change the moment it was picked.
  await seedPrompts([{ id: "e-one", name: "Review first", body: `${NOW}\n` }])
  await copied(afkHost({ features: FEATURES, prompt: NOW, promptId: "e-one" }), async () => {
    assert.equal(marker(), null, "the ends a write trims are not a change in the library")
  })

  // Deleted from the library: the copy stands, and nothing calls it stale.
  await seedPrompts([])
  await copied(afkHost({ features: FEATURES, prompt: NOW, promptId: "e-one" }), async () => {
    assert.equal(marker(), null, "an entry this device no longer holds leaves no label")
    assert.match(row()?.textContent ?? "", /Read the issue first/, "and its copy stands")
  })

  // A host from before the library answers no source at all, whatever the device holds.
  await seedPrompts([{ id: "e-one", name: "Review first", body: COPY }])
  await copied(afkHost({ features: FEATURES, prompt: NOW }), async () => {
    assert.equal(
      marker(),
      null,
      "words the host doesn't say were copied from anywhere are the user's",
    )
  })
})

test("a hand edit writes the words alone, and the label is gone for the next read", async () => {
  await seedPrompts([{ id: "e-one", name: "Review first", body: NOW }])
  const host = afkHost({ features: FEATURES, prompt: COPY, promptId: "e-one" })
  await copied(host, async () => {
    assert.equal(markerText(), "Update available", "the copy starts labelled")

    await click(find('button[aria-label="Prompt"]'))
    await settle()
    await type(field()!, MINE)
    assert.equal(offer(), null, "typing the user's own words retires the offer line")

    await click(findText("button", "Done"))

    assert.deepEqual(
      afkWrites(host).map((call) => call.body),
      [{ prompt: MINE }],
      "editing the copy is a plain write: the words, and no source beside them",
    )
    assert.equal(host.state().source, null, "which clears the copy on the host")
    assert.equal(
      marker(),
      null,
      "so the row never calls the user's own words a stale copy of an entry they left",
    )
  })
})

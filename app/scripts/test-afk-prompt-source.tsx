/**
 * A Prompt that came from the account's library, inside the AFK pop-up: the row says `changed in
 * library` where the entry it was copied from has been rewritten since, and one tap there pulls the
 * entry's current words in — one write of the text and its source together, which takes the marker
 * with it; a pull that can't reach the host is a toast and the marker stands, because the copy still
 * isn't the entry's. And the cases that are silent: a copy that still matches its entry, an entry
 * deleted from the library, a host that answers no source at all, and a Prompt typed by hand, whose
 * plain write detaches the copy on the host so the row never calls the user's own words stale.
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

test("a copy whose entry moved on says so, and one tap pulls the new words in", async () => {
  await seedPrompts([{ id: "e-one", name: "Review first", body: NOW }])
  const host = afkHost({ features: FEATURES, prompt: COPY, promptId: "e-one" })
  await copied(host, async () => {
    assert.match(row()?.textContent ?? "", /Read the diff first/, "the row reads the copy it holds")
    assert.equal(
      markerText(),
      "changed in library",
      "the entry says other words, so the row says the copy has moved on",
    )

    await click(marker())

    assert.deepEqual(
      afkWrites(host).map((call) => call.body),
      [{ prompt: NOW, prompt_id: "e-one" }],
      "the pull writes the entry's current words and its id together, as a pick does",
    )
    assert.equal(marker(), null, "the copy is the entry's again, so there is nothing left to pull")
    assert.match(
      row()?.textContent ?? "",
      /Read the issue first/,
      "and the row reads what the pull wrote",
    )
    assert.equal(host.state().source, "e-one", "a pull keeps the source: it is a pick, not a hand edit")
  })
})

test("a pull that cannot reach the host is a toast, and the marker stands", async () => {
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
      await click(marker())

      assert.deepEqual(said, [REFUSAL], "the host's own refusal reaches the user as a toast")
      assert.equal(
        markerText(),
        "changed in library",
        "nothing was written, so the copy is still not the entry's",
      )
      assert.match(row()?.textContent ?? "", /Read the diff first/, "and the row still reads the copy")
    })
  } finally {
    toast.error = real
  }
})

test("an original, a deleted entry and a host without a source are all unmarked", async () => {
  // The entry still says exactly what was copied: there is nothing to pull.
  await seedPrompts([{ id: "e-one", name: "Review first", body: NOW }])
  await copied(afkHost({ features: FEATURES, prompt: NOW, promptId: "e-one" }), async () => {
    assert.match(row()?.textContent ?? "", /Read the issue first/, "the copy the project holds")
    assert.equal(marker(), null, "the same words in both is no change to say")
  })

  // Deleted from the library: the copy stands, and nothing calls it stale.
  await seedPrompts([])
  await copied(afkHost({ features: FEATURES, prompt: NOW, promptId: "e-one" }), async () => {
    assert.equal(marker(), null, "an entry this device no longer holds leaves no marker")
    assert.match(row()?.textContent ?? "", /Read the issue first/, "and its copy stands")
  })

  // A host from before the library answers no source at all, whatever the device holds.
  await seedPrompts([{ id: "e-one", name: "Review first", body: COPY }])
  await copied(afkHost({ features: FEATURES, prompt: NOW }), async () => {
    assert.equal(marker(), null, "words the host doesn't say were copied from anywhere are the user's")
  })
})

test("a hand edit writes the words alone, and the marker is gone for the next read", async () => {
  await seedPrompts([{ id: "e-one", name: "Review first", body: NOW }])
  const host = afkHost({ features: FEATURES, prompt: COPY, promptId: "e-one" })
  await copied(host, async () => {
    assert.equal(markerText(), "changed in library", "the copy starts marked")

    await click(find('button[aria-label="Prompt"]'))
    await type(find('textarea[aria-label="Prompt"]'), MINE)
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

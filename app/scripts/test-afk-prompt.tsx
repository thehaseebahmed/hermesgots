/**
 * AFK's Prompt row and its editor, over a seeded device database and a faked HTTP boundary: the row
 * drawn only where the host holds a Prompt and the workflow library is off, the words it reads, the
 * editor writing them with no other mode to switch to, the skills pickers the Prompt doesn't need
 * left out, a save answering the row, a refusal keeping the words typed, and an emptied field reading
 * the host's default again.
 */
import assert from "node:assert/strict"
import test from "node:test"
import { act } from "react"
import { toast } from "sonner"

import {
  DEFAULT_AFK_PROMPT,
  afkHost,
  click,
  find,
  findText,
  mountAfk,
  seedSettings,
  type,
} from "./component-kit.tsx"

const config = { baseUrl: "http://hermes.test/v1", apiKey: "test-key" }
const project = "project-1"

const row = () => find("[data-afk-prompt]")
const field = () => find('textarea[aria-label="Prompt"]')
const afkWrites = (host: ReturnType<typeof afkHost>) =>
  host.calls.filter((call) => call.method === "POST" && call.path.endsWith("/afk"))
const fieldValue = () => (field() as HTMLTextAreaElement | null)?.value

/** The Prompt row is drawn where the library is off, which is the Developer setting's own default. */
async function promptMode(host: ReturnType<typeof afkHost>, body: () => Promise<void>) {
  await seedSettings({ developer: true })
  globalThis.fetch = host.fetch as unknown as typeof fetch
  await mountAfk(config, project, body)
}

/** Waits for a render the dismissal's own listener causes, outside the act the click ran in. */
async function settled(check: () => boolean, what: string) {
  for (const end = Date.now() + 5_000; !check() && Date.now() < end;)
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 25))
    })
  assert.ok(check(), what)
}

/** A host that advertises the skill pickers too, so where they are drawn is the app's choice. */
const WITH_SKILLS = ["afk", "afk_switch", "afk_skills", "afk_workflows", "afk_prompt"]

test("the library on, no Prompt row", async () => {
  await seedSettings({ developer: true, afkWorkflows: true })
  globalThis.fetch = afkHost({ features: WITH_SKILLS }).fetch as unknown as typeof fetch
  await mountAfk(config, project, async () => {
    assert.equal(row(), null, "a project running a workflow is told no Prompt")
    assert.match(
      find("[data-afk-workflow]")?.textContent ?? "",
      /Build · Test · Review · Summary/,
      "the Workflow row is the one it draws",
    )
    assert.ok(find("[data-afk-skills]"), "and the workflow's own skill pickers stay")
  })
})

test("the row reads the Prompt the host answers, the default included", async () => {
  await promptMode(afkHost(), async () => {
    assert.match(
      row()?.textContent ?? "",
      /How to work/,
      "an untouched project reads the host's default rather than nothing",
    )
    assert.match(row()?.textContent ?? "", /Run the repo's own gates/, "all of its words are there")
    assert.doesNotMatch(
      row()?.textContent ?? "",
      /#|- Work/,
      "and markdown's own marks are off it: the editor is where it reads as written",
    )
    const words = row()?.textContent ?? ""
    assert.match(
      words,
      /^Prompt\s*How to work/,
      "the label sits over the words, a card rather than a pill",
    )
    assert.ok(row()?.querySelector("svg"), "and the chevron says the row opens something")
  })
})

test("tapping the row opens the editor on the host's words, to write and nothing else", async () => {
  await promptMode(afkHost(), async () => {
    await click(find('button[aria-label="Prompt"]'))
    assert.equal(fieldValue(), DEFAULT_AFK_PROMPT, "the field arrives holding what the row reads")
    assert.equal(
      find('[aria-label="Prompt view"]'),
      null,
      "there is no mode to switch to: a Prompt is written",
    )
    assert.equal(findText("button", "Preview"), null, "and nothing previews it")
  })
})

test("the skills pickers are not drawn under a Prompt", async () => {
  await promptMode(afkHost({ features: WITH_SKILLS }), async () => {
    assert.equal(
      find("[data-afk-skills]"),
      null,
      "a Prompt names its own skills, so Build and Critique have nothing to say",
    )
  })
})

test("Done writes the Prompt, and the row reads what the host answered", async () => {
  const fake = afkHost()
  await promptMode(fake, async () => {
    await click(find('button[aria-label="Prompt"]'))
    await type(field(), "# Mine\n\n- Read the issue first.")
    await click(findText("button", "Done"))

    const writes = afkWrites(fake)
    assert.equal(writes.length, 1, "one write, on Done")
    assert.deepEqual(writes[0].body, { prompt: "# Mine\n\n- Read the issue first." })
    assert.equal(Boolean(field()), false, "the editor closes on the host's answer")
    assert.match(
      row()?.textContent ?? "",
      /Read the issue first/,
      "the row shows what it holds now",
    )
  })
})

test("an emptied field saves as empty, and the row reads the default again", async () => {
  const fake = afkHost({ prompt: "# Mine\n\n- Read the issue first." })
  await promptMode(fake, async () => {
    await click(find('button[aria-label="Prompt"]'))
    await type(field(), "")
    await click(findText("button", "Done"))

    const writes = afkWrites(fake)
    assert.deepEqual(writes[0].body, { prompt: "" }, "the empty field is the write it says it is")
    assert.match(
      row()?.textContent ?? "",
      /How to work/,
      "and the host's default is what the row reads back",
    )
    assert.doesNotMatch(row()?.textContent ?? "", /Read the issue first/)
  })
})

test("Done on the words nobody changed writes nothing", async () => {
  const fake = afkHost()
  await promptMode(fake, async () => {
    await click(find('button[aria-label="Prompt"]'))
    await click(findText("button", "Done")!)
    await settled(() => !field(), "the sheet closes on Done")
    assert.deepEqual(
      afkWrites(fake),
      [],
      "opening the sheet and leaving it would otherwise write the default as the project's own words",
    )
    assert.match(row()?.textContent ?? "", /How to work/, "and the row reads the default still")
  })
})

test("a refusal is a toast, and the words stay where they were typed", async () => {
  const REFUSAL = "The host couldn't save that Prompt."
  const said: unknown[] = []
  const real = toast.error
  toast.error = ((message: unknown) => {
    said.push(message)
    return ""
  }) as typeof toast.error
  try {
    await promptMode(afkHost({ promptRefusal: REFUSAL }), async () => {
      await click(find('button[aria-label="Prompt"]'))
      await type(field(), "# Mine\n\n- Read the issue first.")
      await click(findText("button", "Done"))

      assert.deepEqual(said, [REFUSAL], "the host's own refusal reaches the user as a toast")
      assert.equal(
        fieldValue(),
        "# Mine\n\n- Read the issue first.",
        "the editor keeps the words, ready for another try",
      )
      assert.match(row()?.textContent ?? "", /How to work/, "the row still reads what it held")
    })
  } finally {
    toast.error = real
  }
})

test("the way out without Done writes nothing", async () => {
  const fake = afkHost()
  await promptMode(fake, async () => {
    await click(find('button[aria-label="Prompt"]'))
    await type(field(), "# Mine\n\n- Read the issue first.")
    await act(async () => {
      find('textarea[aria-label="Prompt"]')
        ?.closest('[role="dialog"]')
        ?.dispatchEvent(
          new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }),
        )
    })
    await settled(() => !field(), "Escape closes the editor as the sheet's own way out")

    assert.deepEqual(afkWrites(fake), [], "and nothing reached the host")
    assert.match(row()?.textContent ?? "", /How to work/, "the row reads what it read before")

    await click(find('button[aria-label="Prompt"]'))
    assert.equal(
      fieldValue(),
      DEFAULT_AFK_PROMPT,
      "a fresh open starts from the row again, not from the draft that was left",
    )
  })
})

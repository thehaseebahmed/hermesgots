// AFK's Prompt: with the workflow library off, a project's pop-up draws the Prompt its runs are
// told — the host's default method where the project wrote none — and opens one writing sheet for
// it, Done writing it back to the host, which the next read answers. Geometry is why this is a flow:
// the row's place in the switch's list, the sheet's height and the drawer's edge — none of which a
// DOM without layout can measure.
//
// The account's prompt library is here too, because it needs a signed-in account with its vault
// open on the device and a browser that can hold one: the words are saved to the library by name,
// picked in ANOTHER project as a copy that remembers the entry it came from, and — once the entry is
// rewritten on the library's side — the row wears an `Update` badge whose dialog asks before it
// pulls the new words in, which is a pick again.
import {
  accountUser,
  afkRead,
  app,
  assert,
  flow,
  makeProject,
  openAfk,
  pass,
  seedVault,
  settled,
} from "./lib.mjs"

const DEFAULT_PROMPT = "Work in checkpoints: small slices of the issue, one at a time."
const MINE = "# Mine\n\n- Read the issue first.\n- Run the repo's own gates."
const EDITED = "# Mine, as the library has it now\n\n- Read the issue first.\n- Run every gate."
const ENTRY = "House rules"
/** The width the app's pop-ups become side drawers at, which the editor takes from the same rule. */
const LAPTOP = 1024

/**
 * The account's library is sealed with the vault's key, so a device that never opened the vault
 * isn't offered it. This is that device: a key seeded the way the recovery-code flows seed one, and
 * the sync documents answered, sealed with the same key, as an account with nothing in it yet. The
 * app reads those documents as it starts, and a 404 the stub would otherwise answer is a console
 * error the flow can't tell from the app's own.
 */
const openVault = async (page, profileId) => {
  await seedVault(page, accountUser.id)
  const docs = ["bots", "prompts", "settings", `chats/${profileId}`]
  const sealed = await page.evaluate(
    async ({ userId, docs }) => {
      const vault = await import("/src/lib/vault.ts")
      const { db } = await import("/src/lib/db.ts")
      const { key } = await db.vault.get("key")
      const answers = {}
      for (const doc of docs) answers[doc] = await vault.seal(key, {}, `memento:${userId}:${doc}`)
      return answers
    },
    { userId: accountUser.id, docs },
  )
  const context = page.context()
  await context.route("**/.netlify/functions/sync?**", async (route) => {
    const request = route.request()
    const doc = new URL(request.url()).searchParams.get("doc")
    // A write, and the vault's own document, are the helper's stub's to answer.
    if (request.method() !== "GET" || !sealed[doc]) return route.fallback()
    return route.fulfill({ json: { data: sealed[doc], etag: "v1" } })
  })
  await context.route("**/.netlify/functions/registry?**", (route) =>
    route.fulfill({ json: { bots: {} } }),
  )
  await page.reload()
}

const run = async ({ page, profileId, shot, until }) => {
  const errors = []
  page.on("pageerror", (error) => errors.push(error.message))
  page.on("console", (message) => {
    if (message.type() === "error") errors.push(message.text())
  })
  await openVault(page, profileId)

  const projectId = await makeProject(until, "AFK Prompt")
  const screen = `${app}/projects/${profileId}/${projectId}`

  // The shared opener, then the sheet's slide-in let alone: a box read mid-animation is a moving
  // target, and every measurement here is a box.
  const openPrompt = async (where) => {
    await openAfk(page, where)
    const row = page.locator("[data-afk-prompt]")
    await row.waitFor({ timeout: 15_000 })
    await settled(page)
    return row
  }

  const row = await openPrompt(screen)
  assert.match(
    await row.innerText(),
    /Work in checkpoints/,
    "the row reads the host's default Prompt",
  )
  assert.equal(await page.locator("[data-afk-workflow]").count(), 0, "no Workflow row with it off")
  assert.equal(
    await page.locator("[data-afk-skills]").count(),
    0,
    "and no Build and Critique pickers: a Prompt names its own skills",
  )
  // A row of the switch's own list, with the switch's own padding above it and none of its own.
  const switchBox = await page.locator("[data-afk-switch]").boundingBox()
  const promptBox = await row.boundingBox()
  assert.ok(switchBox && promptBox, "both rows have a box")
  const gap = Math.round(promptBox.y - (switchBox.y + switchBox.height))
  assert.ok(
    gap >= 0 && gap <= 1,
    `the Prompt row touches the switch's row, with no band between (${gap}px)`,
  )
  await shot("row")

  // The words the project's runs are told, written by hand: a plain write, so the row never reads
  // as a copy of anything (`prompt-source.ts`).
  await page.locator('button[aria-label="Prompt"]').click()
  const field = page.locator('textarea[aria-label="Prompt"]')
  await field.waitFor({ timeout: 15_000 })
  assert.equal(await field.inputValue(), DEFAULT_PROMPT, "the field holds the host's words")
  // The library is offered here, which is the account's answer, not the host's: signed in with the
  // vault open, this device holds the account's own entries.
  const doors = page.locator("[data-prompt-library-actions]")
  await doors.waitFor({ timeout: 15_000 })
  assert.equal(
    await page.getByRole("button", { name: "Choose from library" }).count(),
    1,
    "the editor offers the library it can reach",
  )

  // A bottom sheet below a laptop's width, the side drawer from it, and either way room to write.
  const editor = page.getByRole("dialog").last()
  await settled(page)
  const box = await editor.boundingBox()
  const viewport = page.viewportSize()
  assert.ok(box && viewport, "the editor has a box on screen")
  const width = Math.round(box.width)
  const height = Math.round(box.height)
  if (viewport.width < LAPTOP) {
    assert.equal(
      Math.round(box.y + box.height),
      viewport.height,
      "a sheet on the screen's bottom edge",
    )
    assert.ok(height < viewport.height, `a sheet, not the whole screen (${height}px)`)
    assert.equal(
      Math.round(box.x),
      Math.round((viewport.width - width) / 2),
      "centred as every sheet is",
    )
    assert.ok(width <= 640 && width > viewport.width * 0.4, `a sheet's width (${width}px)`)
  } else {
    assert.equal(height, viewport.height, "the side drawer takes the height")
    assert.equal(
      Math.round(box.x + box.width),
      viewport.width,
      "and from a laptop's width, flush right",
    )
    assert.ok(width < viewport.width, `a drawer leaves the project beside it (${width}px)`)
  }
  const fieldBox = await field.boundingBox()
  assert.ok(fieldBox, "the field has a box")
  assert.ok(
    fieldBox.height >= 240,
    `the field opens with room to write (${Math.round(fieldBox.height)}px)`,
  )
  assert.ok(box.height - fieldBox.height >= 44, "and the header and Done sit outside it")
  await shot("editor")

  await field.fill(MINE)
  await page.getByRole("button", { name: "Done" }).click()
  await field.waitFor({ state: "detached", timeout: 15_000 })
  await until(
    async () =>
      (await page.locator("[data-afk-prompt]").innerText()).includes("Read the issue first"),
    15_000,
    "the row to read the Prompt the host took",
  )
  const typed = await afkRead(projectId)
  assert.equal(typed.prompt, MINE, "the host kept the words as they were written")
  assert.equal(typed.prompt_id, null, "and a Prompt typed by hand names no library entry")
  await shot("saved")

  // The same words go to the account's library, by name and tags: a copy on the device, which later
  // reads say came from this entry.
  await page.locator('button[aria-label="Prompt"]').click()
  await field.waitFor({ timeout: 15_000 })
  await page.getByRole("button", { name: "Save to library" }).click()
  const entrySheet = page.locator("[data-prompt-entry]")
  await entrySheet.waitFor({ timeout: 15_000 })
  assert.equal(
    await entrySheet.locator('textarea[aria-label="Body"]').inputValue(),
    MINE,
    "the entry starts from the words on screen",
  )
  await entrySheet.locator('input[aria-label="Name"]').fill(ENTRY)
  await entrySheet.locator('input[aria-label="Tags"]').fill("afk, quality")
  await entrySheet.getByRole("button", { name: "Save" }).click()
  await entrySheet.waitFor({ state: "detached", timeout: 15_000 })
  const entries = await page.evaluate(async () =>
    (await import("/src/lib/db.ts")).db.prompts.toArray(),
  )
  assert.deepEqual(
    entries.map(({ name, tags, body }) => ({ name, tags, body })),
    [{ name: ENTRY, tags: ["afk", "quality"], body: MINE }],
    "the library keeps the entry under its name, tags and words",
  )
  await shot("library")

  // Elsewhere: another project of the same bot, where the account's library is the same one. Its
  // own Prompt is the host's default — nothing of the first project's words follow it — and picking
  // the entry writes the words and the entry they came from in one go.
  const elsewhereId = await makeProject(until, "AFK Prompt pick")
  const elsewhere = `${app}/projects/${profileId}/${elsewhereId}`
  const other = await openPrompt(elsewhere)
  assert.match(await other.innerText(), /Work in checkpoints/, "the other project's own Prompt")
  await page.locator('button[aria-label="Prompt"]').click()
  await field.waitFor({ timeout: 15_000 })
  assert.equal(await field.inputValue(), DEFAULT_PROMPT, "reading the host's default, not a copy")
  await page.getByRole("button", { name: "Choose from library" }).click()
  const library = page.locator("[data-prompt-library]")
  await library.waitFor({ timeout: 15_000 })
  const use = library.getByRole("button", { name: `Use ${ENTRY}` })
  await use.waitFor({ timeout: 15_000 })
  assert.match(await library.innerText(), /quality/, "the entry keeps the tags it was saved with")
  await use.click()
  await library.waitFor({ state: "detached", timeout: 15_000 })
  await until(
    async () => (await afkRead(elsewhereId)).prompt_id !== null,
    15_000,
    "the host to take the words and their source",
  )
  const picked = await afkRead(elsewhereId)
  assert.equal(picked.prompt, MINE, "the pick wrote the entry's words")
  assert.match(picked.prompt_id, /^e-/, "and the entry they were copied from")
  await page.getByRole("button", { name: "Done" }).click()
  await field.waitFor({ state: "detached", timeout: 15_000 })
  await until(
    async () =>
      (await page.locator("[data-afk-prompt]").innerText()).includes("Read the issue first"),
    15_000,
    "the row to read the copy",
  )
  assert.equal(
    await page.locator("[data-afk-prompt-changed]").count(),
    0,
    "a copy that matches its entry is not marked",
  )
  // The project the words were typed in was never a copy, so it isn't marked either.
  const first = await afkRead(projectId)
  assert.equal(first.prompt_id, null, "the first project's own words never named an entry")
  await shot("picked")

  // The entry is rewritten on the library's side — its words, not the project's — and the row says
  // so, since the copy is now stale.
  await page.locator('button[aria-label="Prompt"]').click()
  await field.waitFor({ timeout: 15_000 })
  await page.getByRole("button", { name: "Choose from library" }).click()
  await library.waitFor({ timeout: 15_000 })
  await library.getByRole("button", { name: `Edit ${ENTRY}` }).click()
  await entrySheet.waitFor({ timeout: 15_000 })
  await entrySheet.locator('textarea[aria-label="Body"]').fill(EDITED)
  await entrySheet.getByRole("button", { name: "Save" }).click()
  await entrySheet.waitFor({ state: "detached", timeout: 15_000 })
  await page.getByRole("button", { name: "Done" }).click()
  await field.waitFor({ state: "detached", timeout: 15_000 })
  const marker = page.locator("[data-afk-prompt-changed]")
  await marker.waitFor({ timeout: 15_000 })
  assert.equal(
    (await marker.innerText()).trim(),
    "Update",
    "the badge in front of the title offers the entry's words",
  )
  assert.match(
    await page.locator("[data-afk-prompt]").innerText(),
    /Read the issue first/,
    "while still reading the words the project holds",
  )
  await shot("changed")

  // The badge asks first, and confirming pulls the entry's new words in — writing them and their
  // source together: the badge goes with them, and the host holds the library's words.
  await marker.click()
  const asking = page.getByRole("alertdialog")
  await asking.waitFor({ timeout: 15_000 })
  await asking.getByText("Update this Prompt?", { exact: true }).waitFor({ timeout: 15_000 })
  await shot("update-dialog")
  const before = await afkRead(elsewhereId)
  assert.notEqual(before.prompt, EDITED, "asking alone writes nothing")
  await asking.getByRole("button", { name: "Update" }).click()
  await until(
    async () => (await afkRead(elsewhereId)).prompt === EDITED,
    15_000,
    "the pull to land",
  )
  await marker.waitFor({ state: "detached", timeout: 15_000 })
  const pulled = await afkRead(elsewhereId)
  assert.equal(pulled.prompt_id, picked.prompt_id, "the pulled words keep the entry they came from")
  await until(
    async () =>
      (await page.locator("[data-afk-prompt]").innerText()).includes("as the library has it now"),
    15_000,
    "the row to read what was pulled in",
  )
  assert.equal(
    await page.locator("[data-afk-prompt-changed]").count(),
    0,
    "and the marker to be gone",
  )
  await shot("pulled")

  // What a reload reads is the host's answer: the pulled words, still marked as the entry's copy.
  await openPrompt(elsewhere)
  assert.match(
    await page.locator("[data-afk-prompt]").innerText(),
    /as the library has it now/,
    "a reload reads the Prompt the host kept",
  )
  assert.equal(
    await page.locator("[data-afk-prompt-changed]").count(),
    0,
    "and a copy that matches its entry is still unmarked",
  )

  assert.deepEqual(errors, [], `no console error (${errors.join("; ")})`)
}

for (const width of [390, 768, LAPTOP]) {
  for (const dark of [false, true]) {
    const look = `${width}${dark ? "-dark" : ""}`
    await flow(`afk-prompt-${look}`, run, {
      viewport: { width, height: width < 768 ? 844 : 768 },
      dark,
      account: true,
    })
  }
}
pass(
  "a project's pop-up draws the Prompt its runs are told — the host's default included, with none of the workflow's skill pickers — and opens one writing surface for it in a bottom sheet, the side drawer from a laptop's width, Done writing it back; the account's library saves those words by name, picks them into another project as a copy, and a rewritten entry shows an `Update` badge whose dialog asks, then pulls the new words in: at 390, 768 and 1024px, light and dark",
)

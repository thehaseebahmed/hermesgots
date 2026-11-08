// A room of two bots of one Host: the sidebar lists it without ever having opened it, a message sent
// into it runs the members' rounds on the Host with no client attached, and the screen draws each
// reply with its member's name and picture, the who-is-working line while a turn runs, the third
// round's bound, and a member that passes as nothing at all. A reload lands on the same transcript,
// read from the device rather than the Host.
//
// Then the room's media: a photo picked through the composer's `+` goes up as bytes tied to an
// upload id this device minted, rides the message as a manifest, and is drawn through an address the
// plugin signs over the room, the event and the file — the user's row, and the member's own picture
// in its reply. A tap opens the app's Previewer on it, the copy this device keeps draws it again
// after a reload with the Host never asked, and a file the test host won't take is refused in the
// plugin's words, naming the test host's own limit.
import { assert, flow, mock, pass, pick, png, settled } from "./lib.mjs"

const SENT = "Plan the next release."
const FIRST = "I'll take the API and the routes."
const SECOND = "Coder here. I'll take the screen and the tests."
const BOUND = "The room stopped at its round limit."
const PHOTO = "plan.png"
const WITH_PHOTO = "Here is the plan."
const DECK = "deck.zip"

await flow("rooms", async ({ page, until, shot }) => {
  // The room's members are Hermes profiles, so this device holds a bot for each of them: the bot the
  // flow set up is the Host's own profile, and a second one stands for the other member.
  await page.evaluate(async (baseUrl) => {
    const { addProfile, db } = await import("/src/lib/db.ts")
    const [bot] = await db.profiles.toArray()
    await db.profiles.update(bot.id, { hermesProfile: "default" })
    await addProfile({
      name: "Coder",
      model: "hermes-agent",
      baseUrl: `${baseUrl}/v1`,
      apiKey: (await db.profiles.get(bot.id)).apiKey,
      hermesProfile: "coder",
      pluginChats: true,
    })
  }, mock)

  // The room's row reaches every device from the Host's own projection into the chat list.
  const row = page.getByRole("link", { name: /Planning/ })
  await row.waitFor({ timeout: 20_000 })
  await row.click()
  await page.waitForURL("**/c/room-planning", { timeout: 15_000 })

  const field = page.getByLabel("Message", { exact: true })
  await field.waitFor({ timeout: 15_000 })
  await field.fill(SENT)
  await page.getByRole("button", { name: "Send", exact: true }).click()
  await page.getByText(SENT).first().waitFor({ timeout: 15_000 })

  // While a member's turn runs, the room says who is working — and only while it does.
  const working = page.locator('[data-slot="room-working"]')
  await working.waitFor({ timeout: 15_000 })
  assert.match(await working.innerText(), /is working…/, "the working line names the member")

  // The first member answers, the second passes (which draws nothing), and the second round's reply
  // lands after it; the third round is the Host's bound.
  await page.getByText(FIRST).first().waitFor({ timeout: 20_000 })
  await page.getByText(BOUND).first().waitFor({ timeout: 20_000 })
  const rows = page.locator('[data-slot="room-row"]:not([data-kind="notice"])')
  await until(
    async () => ((await rows.count()) === 3 ? true : null),
    20_000,
    "the room's three rows",
  )

  const drawn = await rows.allInnerTexts()
  assert.deepEqual(
    drawn.map((text) => text.split("\n").at(-1).trim()),
    [SENT, FIRST, SECOND],
    "the pass drew nothing: a round of two members, one of whom stayed silent, is three rows",
  )

  // Each member's reply carries its name and its bot's picture; the user's own message carries
  // neither, and the screen's header names the room and its members.
  const hermes = rows.filter({ hasText: FIRST })
  const coder = rows.filter({ hasText: SECOND })
  assert.match(await hermes.innerText(), /Hermes/, "the reply names its member")
  assert.match(await coder.innerText(), /Coder/, "the other reply names its member")
  assert.equal(await hermes.locator("img").count(), 1, "a member's bubble draws its bot's picture")
  assert.equal(await coder.locator("img").count(), 1, "and the other member's its own")
  assert.notEqual(
    await hermes.locator("img").getAttribute("src"),
    await coder.locator("img").getAttribute("src"),
    "two members, two pictures",
  )
  await page.getByText("Hermes, Coder").first().waitFor({ timeout: 5_000 })
  assert.equal(
    await working.count(),
    0,
    "the room is at rest once its rounds have settled, so no line is drawn",
  )
  await shot("transcript")

  // A reload lands on the same transcript: what the device read is what it draws, and the Host is
  // asked only for what came after it.
  await page.reload()
  await page.getByText(FIRST).first().waitFor({ timeout: 20_000 })
  await page.getByText(SECOND).first().waitFor({ timeout: 20_000 })
  await page.getByText(BOUND).first().waitFor({ timeout: 20_000 })
  const again = await page
    .locator('[data-slot="room-row"]:not([data-kind="notice"])')
    .allInnerTexts()
  assert.deepEqual(
    again.map((text) => text.split("\n").at(-1).trim()),
    [SENT, FIRST, SECOND],
    "a reload reads the same rows back from the device",
  )
  await shot("reloaded")

  // The screen at every size a device is — a phone, a tablet and a laptop, in both themes: a room
  // draws at the app's reading measure and never past it, its rows stay on screen, and the
  // composer keeps its gutters. Geometry is what no DOM without layout measures, so it is here.
  const BOX = 672
  const sizes = [
    { name: "phone", width: 390, height: 844 },
    { name: "tablet", width: 768, height: 1024 },
    { name: "laptop", width: 1440, height: 900 },
  ]
  for (const { name, width, height } of sizes) {
    for (const scheme of ["light", "dark"]) {
      await page.setViewportSize({ width, height })
      await page.emulateMedia({ colorScheme: scheme })
      await settled(page)
      const seen = await page.evaluate(() => {
        const box = (element) => {
          const at = element?.getBoundingClientRect()
          return at ? { left: at.left, right: at.right, width: at.width } : null
        }
        const rows = [
          ...document.querySelectorAll('[data-slot="room-row"]:not([data-kind="notice"])'),
        ]
        return {
          viewport: window.innerWidth,
          rows: rows.map(box),
          field: box(document.querySelector('[aria-label="Message"]')),
          send: box(document.querySelector('button[aria-label="Send"]')),
          room: (() => {
            const at = document.querySelector('[aria-label="Room messages"]')
            const rect = at?.getBoundingClientRect()
            // clientWidth leaves the scroller's own scrollbar out of the room a row is centred in.
            return rect ? { left: rect.left, right: rect.left + at.clientWidth } : null
          })(),
          title: document.querySelector("header")?.innerText.trim() ?? "",
          overflow: document.documentElement.scrollWidth > window.innerWidth,
        }
      })
      const where = `${name} ${scheme}`
      assert.equal(seen.rows.length, 3, `three rows at ${where}`)
      assert.ok(!seen.overflow, `nothing scrolls sideways at ${where}`)
      assert.match(seen.title, /Planning/, `the room's name is on screen at ${where}`)
      assert.ok(seen.field && seen.field.width > 0, `the composer is drawn at ${where}`)
      for (const row of seen.rows) {
        assert.ok(
          row.width <= BOX + 1,
          `a row stays in the reading column at ${where} (${row.width}px)`,
        )
        assert.ok(
          row.left >= -1 && row.right <= seen.viewport + 1,
          `a row stays on screen at ${where}`,
        )
      }
      assert.ok(seen.send && seen.send.right <= seen.viewport + 1, `Send is on screen at ${where}`)
      // Where the pane is wider than the measure, the room's column sits centred in it: the same
      // gutter either side, so a message never drifts towards one edge as the window grows.
      assert.ok(seen.room, `the room's scroller is drawn at ${where}`)
      if (seen.room.right - seen.room.left > BOX + 2) {
        const column = seen.rows[0]
        assert.ok(
          Math.abs(column.left - seen.room.left - (seen.room.right - column.right)) <= 2,
          `the room's column is centred in its pane at ${where}`,
        )
      }
      // One bubble of each side, in the order they are drawn: the user's on the right.
      const user = await page.locator('[data-slot="room-row"][data-kind="user"]').boundingBox()
      const member = await page
        .locator('[data-slot="room-row"][data-kind="member"]')
        .first()
        .boundingBox()
      assert.ok(user && member, `both sides are drawn at ${where}`)
      assert.ok(
        user.x + user.width >= member.x + member.width,
        `the user's message stands right of a member's at ${where}`,
      )
      await shot(`${name}-${scheme}`)
    }
  }
  await page.emulateMedia({ colorScheme: "light" })
  await page.setViewportSize({ width: 1440, height: 900 })

  // A room's files live in the Host's room store and nowhere else: a photo picked through the
  // composer's `+` goes up as bytes against an upload id this device minted, rides the message as a
  // manifest, and is drawn through an address the plugin signs over the room, the event and the
  // file. The message carried a picture, so a member's reply carries one of its own.
  const composer = page.getByLabel("Message", { exact: true })
  assert.equal(
    await pick(page, "Photos", {
      name: PHOTO,
      mimeType: "image/png",
      buffer: Buffer.from(await png(page), "base64"),
    }),
    true,
    "a room whose Host has its room store offers Photos",
  )
  await page.getByRole("button", { name: `Remove ${PHOTO}` }).waitFor({ timeout: 10_000 })
  await composer.fill(WITH_PHOTO)
  await page.getByRole("button", { name: "Send", exact: true }).click()

  // Every row that carries files, with what each of its Gallery cells draws from and whether it has
  // painted: a cell with a URL and no picture is a file the Host never served.
  const drawnCells = () =>
    page.evaluate(() =>
      [...document.querySelectorAll('[data-slot="room-row"]')]
        .map((row) => ({
          kind: row.getAttribute("data-kind"),
          text: row.innerText,
          images: [...row.querySelectorAll('[aria-label="Gallery"] button img')].map((img) => ({
            src: img.getAttribute("src") ?? "",
            painted: img.naturalWidth > 0 && getComputedStyle(img).visibility !== "hidden",
          })),
        }))
        .filter((row) => row.images.length),
    )
  const withMedia = await until(
    async () => {
      const rows = await drawnCells()
      const user = rows.filter((one) => one.kind === "user")
      const member = rows.filter((one) => one.kind === "member")
      const painted = rows.every((one) => one.images.every((image) => image.painted))
      return user.length === 1 && member.length === 1 && painted
        ? { user: user[0], member: member[0] }
        : null
    },
    30_000,
    "the user's photo and a member's own to paint",
  )
  assert.equal(withMedia.user.images.length, 1, "a message's photo is one Gallery cell")
  assert.match(withMedia.user.text, /Here is the plan/, "the cell is on the row that carried it")
  assert.match(
    withMedia.user.images[0].src,
    /\/rooms\/room-planning\/attachment\/att_[0-9a-f]+\?event=.*&token=/,
    "the cell draws through an address the plugin signed for the room, the event and the file",
  )
  assert.match(withMedia.member.text, /Hermes/, "the reply carrying its own picture is a member's")
  assert.match(
    withMedia.member.images[0].src,
    /\/rooms\/room-planning\/attachment\/att_[0-9a-f]+\?event=.*&token=/,
    "a member's own file is drawn exactly as the user's is",
  )
  await shot("media")

  // A tap opens the app's own Previewer on the photo, in the room it was sent to: no tab, and none
  // of the platform's viewer.
  const opened = []
  page.context().on("page", (tab) => opened.push(tab))
  await page.getByRole("button", { name: `Open ${PHOTO}` }).click()
  const preview = page.getByRole("dialog")
  await preview.waitFor({ timeout: 10_000 })
  assert.equal(await preview.getByRole("img", { name: PHOTO }).count(), 1, "the photo is drawn")
  assert.equal(
    await preview.getByRole("button", { name: "Remove" }).count(),
    0,
    "a sent message has no Remove in it",
  )
  await shot("media-previewer")
  await page.getByRole("button", { name: "Close" }).click()
  await preview.waitFor({ state: "hidden", timeout: 10_000 })
  assert.equal(opened.length, 0, "no tab was opened for the photo")

  // A drawn photo is kept on this device, filed under the path the plugin signs: after a reload both
  // cells paint from that copy, and the Host is asked for neither a new address nor a byte of either
  // file — the user's photo and the member's own image alike.
  const idOf = (src) => /attachment\/(att_[0-9a-f]+)\?/.exec(src)[1]
  const photos = [idOf(withMedia.user.images[0].src), idOf(withMedia.member.images[0].src)]
  const asked = []
  page.on("request", (request) => {
    const url = new URL(request.url())
    for (const id of photos) {
      if (url.pathname.endsWith(`/rooms/room-planning/attachment/${id}`)) asked.push(id)
      if (
        url.pathname.endsWith("/rooms/room-planning/attachment/url") &&
        (request.postData() ?? "").includes(id)
      )
        asked.push(id)
    }
  })
  await page.reload()
  const repainted = await until(
    async () => {
      const rows = await drawnCells()
      const painted = rows.every((one) => one.images.every((image) => image.painted))
      return rows.length === 2 && painted ? rows : null
    },
    30_000,
    "both photos to paint again after a reload",
  )
  assert.match(
    repainted.find((one) => one.kind === "user").images[0].src,
    /^blob:/,
    "the reload draws the copy this device kept rather than an address the Host signed",
  )
  assert.match(
    repainted.find((one) => one.kind === "member").images[0].src,
    /^blob:/,
    "and a member's own file draws from this device's copy too",
  )
  for (const [index, id] of photos.entries())
    assert.equal(
      asked.filter((one) => one === id).length,
      0,
      `a drawn photo is never downloaded twice: the ${index ? "member's" : "user's"} was asked for zero times`,
    )
  await shot("media-reloaded")

  // A file the test host won't take: the app's intake is 9 MB, so a 3 MB file reaches it — and the
  // test host's own 2 MB limit is deliberately below that, which is how this leg reaches a Host
  // refusal at all. It refuses in the plugin's words, naming that limit, and the room appends no row.
  // The photo's own round has to be over first, or a reply landing mid-count would read as a row the
  // refused file appended.
  await until(
    async () => ((await page.getByText(BOUND).count()) === 2 ? true : null),
    20_000,
    "the photo's round to reach its bound",
  )
  await pick(page, "Files", {
    name: DECK,
    mimeType: "application/zip",
    buffer: Buffer.alloc(3 * 1024 * 1024, 7),
  })
  await page.getByRole("button", { name: `Remove ${DECK}` }).waitFor({ timeout: 10_000 })
  const before = await page.locator('[data-slot="room-row"]:not([data-kind="notice"])').count()
  await composer.fill("and the deck")
  await page.getByRole("button", { name: "Send", exact: true }).click()
  // The refusal is said where the user's own move is — a toast, and the file's own tile — and no
  // banner stands over the composer saying it again.
  const refusedToast = page
    .locator("[data-sonner-toast]")
    .filter({ hasText: /2 MB limit for a room attachment/ })
  await refusedToast.first().waitFor({ timeout: 20_000 })
  assert.match(
    await refusedToast.first().innerText(),
    new RegExp(`${DECK.replace(".", "\\.")} is larger than the 2 MB limit for a room attachment\\.`),
    "the test host refuses the file in the plugin's words, naming its own limit",
  )
  assert.equal(
    await page.locator('[role="alert"][data-toast-above]').count(),
    0,
    "a refused file is a toast and its own tile, not a banner over the composer",
  )
  assert.equal(
    await page.locator('[data-slot="room-row"]:not([data-kind="notice"])').count(),
    before,
    "a refused file appends no row to the room",
  )
  // The file stays on the composer, drawn in the error's own colour and carrying the Host's
  // sentence, so the reader can take it off; sending again asks the Host again and says it again.
  const marked = page.locator("[data-refused]").filter({ hasText: DECK })
  await marked.waitFor({ timeout: 10_000 })
  assert.match(
    (await marked.getAttribute("title")) ?? "",
    /2 MB limit for a room attachment/,
    "the refused file's tile says why the Host would not take it",
  )
  const toasts = await refusedToast.count()
  await page.getByRole("button", { name: "Send", exact: true }).click()
  await until(
    async () => (await refusedToast.count()) > toasts,
    15_000,
    "the refusal said again on a second send",
  )
  assert.ok(
    await page.getByRole("button", { name: `Remove ${DECK}` }).isVisible(),
    "and the file can still be taken off",
  )
  await shot("media-refused")

  pass(
    `a room's photo drew in its own cell and a member's reply in another, opened in the Previewer, kept on this device across a reload, and a 3 MB file was refused by the test host's own 2 MB limit — its tile marked red and the refusal a toast that a second send said again`,
  )
  pass(
    `a room's message ran three rounds — ${FIRST.length} and ${SECOND.length} characters of reply`,
  )
})

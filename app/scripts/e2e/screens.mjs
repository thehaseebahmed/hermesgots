// Projects, a project, Code, Routines, a chat and a coding session load their data at phone and
// tablet widths, in light and dark mode, with no errors in the console; the session's header is
// centred, with its bot and its repositories under the title rather than a picture beside it.
import {
  app,
  assert,
  assertOneLine,
  centred,
  flow,
  pass,
  readHeader,
  runId,
  settled,
} from "./lib.mjs"

const SESSION_TITLE =
  "Give a coding session's screen the centred header it was promised, with every repository named"
const BRANCH = "hermes/sunny-biscuit-03af"

const errors = []
for (const width of [390, 1024]) {
  for (const dark of [false, true]) {
    const look = `${width}${dark ? "-dark" : ""}`
    await flow(
      `screens-${look}`,
      async ({ page, profileId, send, seed, lastReply, until, shot }) => {
        page.on("pageerror", (error) => errors.push(`${look}: ${error.message}`))
        page.on("console", (message) => {
          if (message.type() === "error") errors.push(`${look}: ${message.text()}`)
        })
        await page.goto(`${app}/projects`)
        await page.getByText("Smart Home", { exact: true }).first().waitFor({ timeout: 15_000 })
        await shot("projects")
        await page.goto(`${app}/projects/${profileId}/p_1a2b3c4d`)
        await page.getByRole("tab", { name: "Pull requests" }).waitFor({ timeout: 15_000 })
        await shot("project")
        await page.goto(`${app}/code`)
        await page.getByRole("button", { name: "New session" }).first().waitFor({ timeout: 15_000 })
        await shot("code")
        await page.goto(`${app}/routines`)
        await page.getByText("Inbox triage").first().waitFor({ timeout: 15_000 })
        await shot("routines")

        // Nothing is sent from it — the host's workspace answer would replace the worktree seeded here.
        const sessionId = `e2e-header-${runId()}`
        await seed([
          {
            id: sessionId,
            hermesSessionId: sessionId,
            title: SESSION_TITLE,
            projectId: "p_1a2b3c4d",
            mode: "auto",
            worktree: {
              branch: BRANCH,
              instructions: "",
              repos: [
                { name: "mock-user/memento", branch: BRANCH },
                { name: "mock-user/gots-app", branch: BRANCH },
                { name: "mock-user/docs", branch: BRANCH },
                { name: "mock-user/website", branch: BRANCH },
              ],
            },
          },
        ])
        await page.evaluate(async (id) => {
          const { db } = await import("/src/lib/db.ts")
          await db.messages.put({
            id: `${id}-opening`,
            conversationId: id,
            role: "user",
            content: "Ship the header",
            status: "done",
            createdAt: Date.now() - 900,
          })
        }, sessionId)
        await page.goto(`${app}/c/${sessionId}`)
        // The app shell's own header is in the page too, so the session's is the one with its title.
        const header = page.locator("header").filter({ hasText: SESSION_TITLE })
        const title = header.getByText(SESSION_TITLE, { exact: true })
        await title.waitFor({ timeout: 15_000 })
        await settled(page)
        await shot("session")

        assert.equal(
          await header.locator('[role="img"]').count(),
          0,
          `no bot picture in the session's header at ${look}`,
        )
        // The owner the repositories share said once, the names the width has room for, the rest counted.
        const line = width < 768 ? "Test bot · memento +3" : "Test bot · memento, gots-app +2"
        const subtitle = header.getByText(/^Test bot · /)
        await subtitle.first().waitFor({ timeout: 5_000 })
        assert.equal(
          (await subtitle.first().innerText()).trim(),
          line,
          `the session's line names the bot and the repositories at ${look}`,
        )
        assert.ok(
          !(await header.innerText()).includes(BRANCH),
          `the branch is not in the session's header at ${look}`,
        )
        await assertOneLine(title, `the session's title at ${look}`)
        await assertOneLine(subtitle.first(), `the session's line at ${look}`)

        const boxes = await readHeader(header.locator('[data-slot="header-row"]'))
        assert.ok(
          boxes.scroll > boxes.client,
          `the session's title truncates at ${look} (${boxes.scroll}px of ${boxes.client}px)`,
        )
        // The count is decided before the line is drawn, so the whole line — its +N with it — fits.
        assert.ok(
          boxes.lineScroll <= boxes.lineClient + 1,
          `the session's line fits at ${look} (${boxes.lineScroll}px of ${boxes.lineClient}px)`,
        )
        centred(boxes, look)

        await page.goto(app)
        await send("hello")
        await page.waitForURL("**/c/**", { timeout: 15_000 })
        const chatId = new URL(page.url()).pathname.split("/").at(-1)
        await until(
          async () => (await lastReply(chatId))?.status === "done",
          20_000,
          "the reply to finish",
        )
        await shot("chat")
        // The width's own boundaries: exactly 768 draws a tablet's two names, and a laptop's width
        // draws three. The session then sits beside Code's list, so its room is not the one measured
        // above — and the same centring gates hold in it.
        if (width === 1024) {
          for (const [at, expected] of [
            [768, "Test bot · memento, gots-app +2"],
            [1280, "Test bot · memento, gots-app, docs +1"],
          ]) {
            await page.setViewportSize({ width: at, height: at === 768 ? 768 : 900 })
            await page.goto(`${app}/c/${sessionId}`)
            const laptop = page.locator("header").filter({ hasText: SESSION_TITLE })
            const laptopLine = laptop.getByText(/^Test bot · /)
            await laptopLine.first().waitFor({ timeout: 15_000 })
            assert.equal(
              (await laptopLine.first().innerText()).trim(),
              expected,
              `the session's line names what a ${at}px screen has room for (${look})`,
            )
            const boxes = await readHeader(laptop.locator('[data-slot="header-row"]'))
            centred(boxes, `${at}px in ${look}`)
          }
        }
        pass(
          `Projects, a project, Code, Routines, a chat and a session's centred header load at ${look}`,
        )
      },
      { viewport: { width, height: width < 768 ? 844 : 768 }, dark },
    )
  }
}
// A failed fetch the browser logs on its own (a 404 with no CORS headers) isn't the app's error.
const real = errors.filter((e) => !/Failed to load resource|CORS policy/.test(e))
assert.deepEqual(real, [], "no errors in the console")
pass("no errors in the console")

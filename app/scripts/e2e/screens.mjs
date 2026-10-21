// Projects, a project, Code, Routines, a chat and a coding session load their data at phone and
// tablet widths, in light and dark mode, with no errors in the console; the session's header is
// centred, with its bot and its repositories under the title rather than a picture beside it.
import { app, assert, assertOneLine, flow, pass, runId, settled } from "./lib.mjs"

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

        // A session that has started: a place in a project, so its header is centred, its bot's name
        // and the repositories it works in under the title. Nothing is sent from it — the host's
        // workspace answer would replace the worktree seeded here.
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

        // A session's header has no picture: the title and its line take the room.
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

        // The title truncates rather than pushing the controls: its text is wider than its box. Its
        // block and its line sit centred in the room the controls leave — the row's own centre on a
        // phone, where the back control and the actions are the same width.
        const geometry = await header.evaluate((el) => {
          const rect = (slot) => {
            const r = el.querySelector(`[data-slot="${slot}"]`).getBoundingClientRect()
            return { x: r.x, width: r.width, right: r.right }
          }
          return {
            scroll: el.querySelector('[data-slot="header-title"]').scrollWidth,
            client: el.querySelector('[data-slot="header-title"]').clientWidth,
            title: rect("header-title"),
            line: rect("header-line"),
            text: rect("header-text"),
            row: rect("header-row"),
          }
        })
        assert.ok(
          geometry.scroll > geometry.client,
          `the session's title truncates at ${look} (${geometry.scroll}px of ${geometry.client}px)`,
        )
        const centre = (box) => box.x + box.width / 2
        assert.ok(
          geometry.title.x >= geometry.text.x - 2 &&
            geometry.title.right <= geometry.text.right + 2,
          `the title stays in the room the controls leave at ${look}`,
        )
        assert.ok(
          Math.abs(centre(geometry.title) - centre(geometry.text)) <= 2,
          `the title is centred in that room at ${look}`,
        )
        assert.ok(
          Math.abs(centre(geometry.line) - centre(geometry.title)) <= 2,
          `the session's line is centred under the title at ${look}`,
        )
        if (width < 768)
          assert.ok(
            Math.abs(centre(geometry.title) - centre(geometry.row)) <= 2,
            `the title is centred on the row at ${look}`,
          )

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

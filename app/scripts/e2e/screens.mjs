// Code, a project, Routines and a chat load their data at phone and tablet widths, in light and
// dark mode, with no errors in the console.
import { app, assert, flow, pass } from "./lib.mjs"

const errors = []
for (const width of [390, 1024]) {
  for (const dark of [false, true]) {
    const look = `${width}${dark ? "-dark" : ""}`
    await flow(
      `screens-${look}`,
      async ({ page, profileId, send, lastReply, until, shot }) => {
        page.on("pageerror", (error) => errors.push(`${look}: ${error.message}`))
        page.on("console", (message) => {
          if (message.type() === "error") errors.push(`${look}: ${message.text()}`)
        })
        await page.goto(`${app}/code`)
        await page.getByText("Smart Home", { exact: true }).first().waitFor({ timeout: 15_000 })
        await shot("code")
        await page.goto(`${app}/code/${profileId}/p_1a2b3c4d`)
        await page.getByRole("button", { name: "New session" }).waitFor({ timeout: 15_000 })
        await shot("project")
        await page.goto(`${app}/routines`)
        await page.getByText("Inbox triage").first().waitFor({ timeout: 15_000 })
        await shot("routines")
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
        pass(`Code, a project, Routines and a chat load at ${look}`)
      },
      { viewport: { width, height: width < 768 ? 844 : 768 }, dark },
    )
  }
}
// A failed fetch the browser logs on its own (a 404 with no CORS headers) isn't the app's error.
const real = errors.filter((e) => !/Failed to load resource|CORS policy/.test(e))
assert.deepEqual(real, [], "no errors in the console")
pass("no errors in the console")

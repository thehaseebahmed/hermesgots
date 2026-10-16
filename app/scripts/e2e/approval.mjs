// A project session asks for an approval: it waits in the sidebar's Waiting for input and in its
// project's Waiting on you, and both move it to Today once it's allowed. At 1440px the session, its
// project and the sidebar are on screen together.
import { app, assert, flow, pass } from "./lib.mjs"

await flow("approval", async ({ page, profileId, seed, send, shot }) => {
  await seed([{ id: "e2e-approval", title: "Log cleanup", projectId: "p_1a2b3c4d" }])
  const waiting = page.getByRole("navigation", { name: "Waiting for input" })
  const group = (label) => page.getByRole("region", { name: label })

  await page.goto(`${app}/c/e2e-approval`)
  await send("clean up the old logs")
  await page.getByRole("button", { name: "Allow once" }).waitFor({ timeout: 20_000 })
  await waiting.getByText("Log cleanup").waitFor({ timeout: 15_000 })
  await group("Waiting on you").getByText("Log cleanup").waitFor({ timeout: 15_000 })
  await shot("waiting")
  pass("the sidebar and the project both show the session waiting")

  await page.getByRole("button", { name: "Allow once" }).click()
  await page.getByText("Approved once").waitFor({ timeout: 15_000 })
  await page.goto(`${app}/code/${profileId}/p_1a2b3c4d`)
  await group("Today").getByText("Log cleanup").waitFor({ timeout: 30_000 })
  assert.equal(await waiting.getByText("Log cleanup").count(), 0, "the sidebar stops waiting")
  await shot("idle")
  pass("once allowed, the project lists it under Today")
})

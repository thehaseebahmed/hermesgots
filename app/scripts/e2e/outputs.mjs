// The outputs drawer above a project session's composer: the pill counts the session's filed files
// and every pull request it has, and opens a drawer with two tabs — its pull requests, the live ones
// and the finished ones, and the project Library's tree restricted to the session's own folders.
import { app, assert, flow, pass, runId } from "./lib.mjs"

/** A chat's stored outputs, as the pill above its composer counts them. */
const outputs = (page, id) =>
  page.evaluate(async (id) => {
    const { db } = await import("/src/lib/db.ts")
    return (await db.conversations.get(id))?.library?.count ?? null
  }, id)

await flow("outputs", async ({ page, seed, send, stored, until, shot }) => {
  // A session that ships twice: the pull request it opened first is merged by the second, so the
  // drawer has a live one and a finished one behind it.
  const id = `outputs-${runId()}`
  await seed([{ id, title: "Rotate the logs", projectId: "p_1a2b3c4d" }])
  await page.goto(`${app}/c/${id}`)
  await send("ship it")
  await until(async () => (await stored(id))?.length, 30_000, "the first pull request")
  await send("ship it again")
  await until(
    async () => (await stored(id))?.length === 2,
    30_000,
    "the second pull request, with the first merged behind it",
  )
  assert.deepEqual(
    (await stored(id)).map((pr) => [pr.number, pr.state]),
    [
      [28, "open"],
      [27, "merged"],
    ],
    "the session's whole history comes back, newest first, the finished one included",
  )

  // The pill counts the five files the session filed and its two pull requests together.
  const pill = page.getByRole("button", { name: /^Outputs \(\d+\)$/ })
  await pill.waitFor({ timeout: 15_000 })
  assert.equal(
    (await pill.textContent())?.trim(),
    "7 outputs",
    "the pill counts the session's outputs and its pull requests",
  )
  await pill.click()
  const drawer = page.getByRole("dialog")
  await drawer.waitFor({ timeout: 15_000 })
  // It opens on the pull requests, since the session has them: one cozy list, newest at the top.
  await drawer.getByText("#28").waitFor({ timeout: 15_000 })
  const listed = await drawer.locator("ul > li").allInnerTexts()
  assert.equal(listed.length, 2, "both pull requests, listed")
  assert.match(listed[0], /Open · #28/, "the live one at the top")
  assert.match(listed[1], /Merged · #27/, "the finished one below it, newest to oldest")
  assert.equal(
    await drawer.getByText(/^(Open|Done) \(/).count(),
    0,
    "no groups: the drawer lists them straight down",
  )
  await shot("prs")
  pass("the drawer lists the session's pull requests newest first, live and finished in one list")

  // The Library tab is the project Library's tree, this session's own folders only.
  await drawer.getByRole("tab", { name: "Library" }).click()
  await drawer.getByText("log-cleanup").waitFor({ timeout: 15_000 })
  assert.equal(
    await drawer.getByText("library-tab").count(),
    1,
    "the session's own folders, one row each",
  )
  assert.equal(
    await drawer.getByText("Rotate the logs").count(),
    0,
    "no session name under a folder: this tree is one session's",
  )
  assert.equal(
    await drawer.getByRole("button", { name: /^Sort the library by/ }).count(),
    0,
    "no sort menu: a session's own tree keeps the newest first",
  )
  await drawer.getByText("library-tab").click()
  await drawer.getByText("dashboard-light.png").waitFor({ timeout: 5_000 })
  await shot("library")
  pass("the Library tab is the project Library's tree, the session's folders only")

  // The drawer in each of its forms — a bottom sheet on a phone, the same sheet capped and centred on
  // a tablet, a side drawer from 1024px — in both modes.
  await drawer.getByRole("tab", { name: "PRs" }).click()
  for (const [width, dark] of [
    [390, false],
    [390, true],
    [768, false],
    [768, true],
    [1024, false],
    [1440, false],
  ]) {
    const look = `${width}${dark ? "-dark" : ""}`
    await page.setViewportSize({ width, height: width < 768 ? 844 : 900 })
    await page.emulateMedia({ colorScheme: dark ? "dark" : "light" })
    await page.waitForTimeout(500)
    await shot(`prs-${look}`)
    const shown = page.getByRole("dialog")
    await shown.getByRole("tab", { name: "Library" }).click()
    await shown.getByText("log-cleanup").waitFor({ timeout: 15_000 })
    // One folder open, so the room under an open folder shows at every width.
    if (!(await shown.getByText("dashboard-light.png").count())) {
      await shown.getByText("library-tab").click()
    }
    await shown.getByText("dashboard-light.png").waitFor({ timeout: 5_000 })
    await shot(`library-${look}`)
    await shown.getByRole("tab", { name: "PRs" }).click()
  }
  pass("the drawer draws as a bottom sheet on phones and tablets and a side drawer from 1024px")

  // Some outputs and no pull request: the same pill, opening on the library it only has.
  const filed = `outputs-files-${runId()}`
  await seed([{ id: filed, title: "Filed charts", projectId: "p_1a2b3c4d" }])
  await page.goto(`${app}/c/${filed}`)
  // A session that worked without shipping: its turn gives it a workspace and a library folder.
  await send("hello there")
  await until(() => outputs(page, filed), 30_000, "the session's filed files to be counted")
  const only = page.getByRole("button", { name: /^Outputs \(\d+\)$/ })
  await only.waitFor({ timeout: 15_000 })
  assert.equal(
    (await only.textContent())?.trim(),
    "5 outputs",
    "a session with no pull requests counts its files alone",
  )
  assert.equal(
    await page.getByRole("button", { name: /^Pull request / }).count(),
    0,
    "no pull request pill for a session without one",
  )
  await only.click()
  const filedDrawer = page.getByRole("dialog")
  await filedDrawer.getByRole("tab", { name: "Library" }).waitFor({ timeout: 15_000 })
  assert.equal(
    await filedDrawer.getByRole("tab", { name: "Library", selected: true }).count(),
    1,
    "a session with no pull requests opens on the Library tab",
  )
  await filedDrawer.getByRole("tab", { name: "PRs" }).click()
  await filedDrawer.getByText("No pull requests yet.").waitFor({ timeout: 5_000 })
  await shot("no-prs")
  pass("a session with outputs and no pull request opens the drawer on its library")

  // One pull request and nothing filed: the pull request's own pill, opening it on GitHub, as before.
  const shipped = `outputs-one-${runId()}`
  await seed([{ id: shipped, title: "One pull request", projectId: "p_1a2b3c4d" }])
  await page.evaluate(async (id) => {
    const { db } = await import("/src/lib/db.ts")
    await db.conversations.update(id, {
      prs: [
        {
          repo: "mock-user/mock-repo",
          number: 142,
          title: "A pull request already open",
          state: "open",
          checks: "success",
          url: "https://github.com/mock-user/mock-repo/pull/142",
          at: Date.now(),
        },
      ],
    })
  }, shipped)
  await page.goto(`${app}/c/${shipped}`)
  await page.getByRole("button", { name: /^Pull request 142 in / }).waitFor({ timeout: 15_000 })
  assert.equal(
    await page.getByRole("button", { name: /^Outputs \(\d+\)$/ }).count(),
    0,
    "one pull request and nothing filed keeps the pull request's own pill",
  )
  await shot("one-pr")
  pass("one pull request and no outputs keeps the pull request pill, opening GitHub")
})

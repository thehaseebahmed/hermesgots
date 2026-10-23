// Run with Vite on APP_URL and an isolated mock on MOCK_URL. Requires Playwright.
// REAL_CLARIFY_TRANSCRIPT optionally supplies captured assistant/tool rows (never commit them).
import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE ?? "playwright")
import { launch, settleNav } from "./e2e/lib.mjs"
const app = process.env.APP_URL ?? "http://localhost:15173"
const mock = process.env.MOCK_URL ?? "http://localhost:18642"
const browser = await launch(chromium, true)
const responses = [
  {
    question: "Which logs?",
    choices_offered: ["Older than 90 days"],
    user_response: "Older than 90 days",
  },
]
function transcript(result) {
  return [
    {
      id: 1,
      role: "assistant",
      content: null,
      tool_calls: [
        {
          id: "call-question",
          type: "function",
          function: { name: "clarify", arguments: JSON.stringify({ question: "Which logs?" }) },
        },
      ],
    },
    {
      id: 2,
      role: "tool",
      tool_call_id: "call-question",
      tool_name: "clarify",
      content: JSON.stringify(result),
    },
  ]
}
async function check(rows, title, expectedAnswers = []) {
  const context = await browser.newContext({ viewport: { width: 1024, height: 768 } })
  const page = await settleNav(await context.newPage())
  try {
    await page.route("**/api/sessions/fixture-session/messages?*", (route) => {
      const limit = Number(new URL(route.request().url()).searchParams.get("limit"))
      return route.fulfill({ json: { data: rows.slice(-limit) } })
    })
    await page.goto(app)
    const id = await page.evaluate(async (mock) => {
      const { db, createConversation } = await import("/src/lib/db.ts")
      const profile = (await db.profiles.toArray())[0]
      await db.profiles.update(profile.id, {
        baseUrl: `${mock}/v1`,
        apiKey: "mock-key",
        pluginChats: true,
      })
      await db.settings.put({ id: "settings", activeProfileId: profile.id, onboarded: true })
      const c = await createConversation(profile.id, {
        title: "Fresh transcript",
        projectId: "p_1a2b3c4d",
      })
      await db.conversations.update(c.id, { hermesSessionId: "fixture-session" })
      return c.id
    }, mock)
    await page.goto(`${app}/c/${id}`)
    await page.evaluate(
      async (id) => (await import("/src/lib/history.ts")).reconcileHistory(id),
      id,
    )
    const cardTitle = page.getByText(/^(Answered|No answer|Not answered|Skipped)$/)
    await cardTitle.waitFor({ timeout: 10000 })
    assert.equal(await cardTitle.textContent(), title)
    for (const answer of expectedAnswers)
      await page.getByText(answer.trim(), { exact: true }).waitFor()
    const message = await page.evaluate(
      async (id) =>
        (await (await import("/src/lib/db.ts")).getMessages(id)).findLast(
          (m) => m.role === "assistant",
        ),
      id,
    )
    assert.equal(
      message.clarify,
      undefined,
      "Fresh history must not rely on a locally settled form",
    )
    await page.reload()
    await page.getByText(title, { exact: true }).waitFor()
  } finally {
    await page.unrouteAll({ behavior: "ignoreErrors" })
    await context.close()
  }
}
try {
  await check(transcript({ responses: [], outcome: "undelivered" }), "Not answered")
  await check(transcript({ responses: [], outcome: "cancelled" }), "Not answered")
  await check(transcript({ responses: [], outcome: "submitted" }), "Skipped")
  await check(transcript({ responses: [], timed_out: true }), "No answer")
  await check(transcript({ responses }), "Answered", [responses[0].user_response])
  await check(
    transcript({
      responses: [{ ...responses[0], user_response: ["Older than 90 days", "Keep current logs"] }],
      outcome: "submitted",
    }),
    "Answered",
    ["Older than 90 days", "Keep current logs"],
  )
  if (process.env.REAL_CLARIFY_TRANSCRIPT) {
    const rows = JSON.parse(await readFile(process.env.REAL_CLARIFY_TRANSCRIPT, "utf8"))
    const result = JSON.parse(rows.find((row) => row.role === "tool").content)
    const answers = result.responses
      .flatMap((r) => (Array.isArray(r.user_response) ? r.user_response : [r.user_response]))
      .filter(Boolean)
    assert.ok(answers.length, "Captured transcript must contain actual answers")
    // Two independent browser profiles: no local message state, only the persisted real rows.
    await check(rows, "Answered", answers)
    await check(rows, "Answered", answers)
    console.log(
      "PASS: actual Hermes transcript renders its answers after reload in two fresh browser profiles",
    )
  }
  console.log(
    "PASS: clarify outcomes, stable responses, and multi-select answers from fresh history",
  )
} finally {
  await browser.close()
}

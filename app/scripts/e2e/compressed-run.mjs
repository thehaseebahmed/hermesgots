// A chat another device started and Hermes compressed before this device ever loaded it: opening it
// must land the transcript and follow the run to its end. Compression moves the chat on to a child
// session — the host keys the run and its rows there (`/api/sessions/{id}/messages` resolves back
// through the lineage), while Gots knows the chat only by the id it started with — so this drives
// both shapes a load can meet: the rotation before the live run starts (the run is keyed on the
// child) and mid-run (it keeps the id it began with). The claim: loading the chat wedges it, and
// only Stop brings the turn down; what must happen instead is written below as the assertions.
import { app, assert, flow, mock, pass, runId } from "./lib.mjs"

const auth = { "Content-Type": "application/json", Authorization: "Bearer mock-key" }

async function hostRun(sessionId, input) {
  const started = await fetch(`${mock}/v1/runs`, {
    method: "POST",
    headers: auth,
    body: JSON.stringify({ session_id: sessionId, input }),
  })
  assert.equal(started.status, 202, "the host starts the run")
  return (await started.json()).run_id
}

async function endOf(runId, ms = 90_000) {
  for (const stop = Date.now() + ms; Date.now() < stop; ) {
    const body = await (await fetch(`${mock}/v1/runs/${runId}`, { headers: auth })).json()
    if (["completed", "cancelled", "failed"].includes(body.status)) return body
    await new Promise((done) => setTimeout(done, 500))
  }
  throw new Error(`the host's run ${runId} never ended`)
}

const compress = (session, child) =>
  fetch(`${mock}/__mock/compress`, {
    method: "POST",
    headers: auth,
    body: JSON.stringify({ session, child }),
  })

async function compressed(name, { beforeRun }) {
  await flow(name, async ({ page, seed, lastReply, until, shot }) => {
    const suffix = runId()
    const chatId = `e2e-comp-${suffix}`
    const sessionId = `memento-${chatId}`
    const childId = `${sessionId}-c1`
    // A chat synced from another device: it has turns on Hermes and none on this one yet.
    await seed([{ id: chatId, title: "Compressed", hermesSessionId: sessionId }])
    const messages = () =>
      page.evaluate(async (id) => {
        const { db } = await import("/src/lib/db.ts")
        const all = await db.messages.where("conversationId").equals(id).sortBy("createdAt")
        return all.map((m) => ({ role: m.role, status: m.status, length: m.content.length }))
      }, chatId)

    // The turn another device ran before compression: all of it is on Hermes, none of it here.
    const earlier = await hostRun(sessionId, "hello there")
    await endOf(earlier)

    if (beforeRun) await compress(sessionId, childId)
    // Another device sends the long turn: keyed on the live tip when the rotation already happened,
    // on the id it began with when compression lands mid-run.
    const live = await hostRun(sessionId, "tell me a long story")
    if (!beforeRun) await compress(sessionId, childId)

    await page.goto(`${app}/c/${chatId}`)
    await shot("open")

    // "It all comes down": the transcript lands when the chat loads.
    const history = await until(async () => {
      const seen = await messages()
      return seen.length >= 2 ? seen : null
    }, 20_000, "the chat to load its transcript from Hermes")
    pass(`the transcript came down on open (${history.length} rows)`)

    // The open chat follows the run another device started, as an uncompressed one does.
    let stuck
    const streaming = await until(async () => {
      const reply = await lastReply(chatId)
      return reply?.status === "streaming" ? reply : null
    }, 25_000, "the open chat to follow the running turn").catch(async (error) => {
      stuck = `the open chat never followed the run (${error.message}); mid-run it held ${JSON.stringify(await messages())}`
      return null
    })

    if (streaming) {
      pass(`the chat follows the run (${streaming.length} characters so far)`)
      await endOf(live)
      // And the reply lands by itself once the host is done: nothing to press.
      const done = await until(async () => {
        const reply = await lastReply(chatId)
        return reply?.status === "done" ? reply : null
      }, 20_000, "the reply to land without pressing Stop").catch(async (error) => {
        stuck = `the run ended on the host but the reply stayed ${JSON.stringify(await lastReply(chatId))} (${error.message})`
        return null
      })
      if (done) pass(`the reply finished on its own (${done.length} characters)`)
    } else {
      await endOf(live).catch(() => undefined)
    }
    if (!stuck) return

    // The user's recovery: Stop brings the whole turn down at once.
    await shot("stuck")
    const stop = page.getByRole("button", { name: "Stop" })
    const canStop = await stop.isVisible().catch(() => false)
    if (canStop) {
      await stop.click()
      await until(async () => {
        const reply = await lastReply(chatId)
        return reply && reply.status !== "streaming" && reply.length ? reply : null
      }, 15_000, "Stop to bring the turn down").catch(() => undefined)
    }
    const after = await messages()
    throw new Error(
      `${name}: ${stuck}. After ${canStop ? "Stop" : "no Stop button"} the chat holds ${JSON.stringify(after)}`,
    )
  })
}

const failures = []
for (const [name, options] of [
  ["compressed-run", { beforeRun: true }],
  ["compressed-mid-run", { beforeRun: false }],
]) {
  try {
    await compressed(name, options)
  } catch (error) {
    failures.push(`${error.message}`)
  }
}
if (failures.length) throw new Error(failures.join("\n\n"))

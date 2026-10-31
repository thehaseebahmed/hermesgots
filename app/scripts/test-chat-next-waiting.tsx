/**
 * A run that waits on the user: a question the agent asked, or a command that needs approval. On
 * Hermes 0.22.5 each is a prompt in the run's status (`pending_controls`) and an event, answered
 * through Hermes's own `POST /v1/runs/{id}/{approval,clarify}` with exactly `{request_id,
 * execution_generation, choice | answer}`. A device that follows the run sees the request arrive on
 * its events; one that only watches finds it on the status, a read that is not a subscription.
 */
import assert from "node:assert/strict"
import test from "node:test"
import { toast } from "sonner"

import { fakeHost, type Ask } from "./chat-next-host.ts"
import {
  eventually,
  openDevice,
  sendFrom,
  showsEverything,
  wait,
  type Device,
  type Host,
  withDevice,
} from "./chat-next-devices.tsx"
import { WAITING_ON_ANSWER } from "@/lib/format"

const TEA: Ask = {
  question: "Which do you prefer?",
  choices: ["tea", "coffee"],
  multi_select: false,
}
const asking = { text: "Which do you prefer?", choices: ["tea", "coffee"] }

const setUp = (name: string) => {
  const host = fakeHost(`memento-waiting-${name}`, { plugin: true })
  return host
}

/**
 * A host that keeps no replay of a prompt's request: it goes only to the subscribers there when it
 * was made, so a device that opens the chat afterwards has the run's status to read it from — what
 * a phone coming back to a waiting run meets.
 */
const withholding = (name: string) =>
  fakeHost(`memento-withheld-${name}`, { plugin: true, withhold: true })

/** Another device answering: a request straight to the host, with no screen of ours involved. */
const answerElsewhere = (run: string, prompt_id: string, answer: string) =>
  fetch(`http://hermes.test/v1/runs/${run}/clarify`, {
    method: "POST",
    body: JSON.stringify({ request_id: prompt_id, execution_generation: 1, answer }),
  })

/** Another device stopping it: the run ends as cancelled and its stream closes. */
const stopElsewhere = (run: string) =>
  fetch(`http://hermes.test/v1/runs/${run}/stop`, { method: "POST" })

const questionOf = (device: Device) => device.waiting().question

/** An open chat's pace between turns: slow enough that a poll cannot take back what a test is looking at. */
const SLOW = { pollMs: 5_000, idleMs: 5_000 }

const waitingOn = async (host: Host, device: Device) => {
  await eventually(
    () => assert.deepEqual(questionOf(device), asking),
    "the question, and its form",
    200,
  )
  await eventually(
    () => assert.ok(host.asked.subscriptions > 0),
    "the run's events are being read",
    200,
  )
}

test.describe("a question the agent asked", () => {
  test("the device that sent the turn sees it arrive, answers it, and the run carries on", async () => {
    const host = setUp("q-here")
    await withDevice(openDevice(host), async (phone) => {
      const run = await sendFrom(phone, host, "go")
      const prompt_id = run.ask(TEA)
      await eventually(
        () => assert.deepEqual(questionOf(phone), asking),
        "the question, with its choices",
      )
      await phone.choose("tea")
      await eventually(
        () =>
          assert.deepEqual(host.answers, [
            { run: host.latest.id, prompt_id, generation: 1, answer: "tea" },
          ]),
        "the host was given the answer in the shape it takes",
      )
      await eventually(
        () => assert.equal(questionOf(phone), undefined),
        "the card goes once answered",
      )
      run.say("\n\nTea it is.")
      run.finish("Tea it is.")
      await showsEverything(phone, host, "the turn, with the question and its answer")
    })
  })

  test("a second question after the first replaces the card", async () => {
    const host = setUp("q-two")
    await withDevice(openDevice(host), async (phone) => {
      const run = await sendFrom(phone, host, "go")
      run.ask(TEA)
      await eventually(() => assert.deepEqual(questionOf(phone), asking), "the first question")
      await phone.choose("tea")
      await eventually(() => assert.equal(questionOf(phone), undefined), "the first card goes")
      run.ask({ question: "Sugar?", choices: ["yes", "no"], multi_select: false })
      await eventually(
        () => assert.deepEqual(questionOf(phone), { text: "Sugar?", choices: ["yes", "no"] }),
        "the second question, as its own card",
      )
      await phone.choose("no")
      run.finish("Tea, no sugar.")
      await showsEverything(phone, host, "both questions and their answers")
    })
  })

  test("a device that only watches finds it on the run's status and can answer it", async () => {
    const host = setUp("q-watch")
    const run = host.startElsewhere("from the laptop")
    run.ask(TEA)
    await withDevice(openDevice(host), async (phone) => {
      await eventually(
        () => assert.deepEqual(questionOf(phone), asking),
        "the question, read from status",
      )
      await phone.choose("coffee")
      await eventually(() => assert.equal(host.answers.length, 1), "the host was given the answer")
      run.finish("Coffee it is.")
      await showsEverything(phone, host, "the turn, with the question and its answer")
    })
  })

  test("a device that was away finds the question waiting when it comes back", async () => {
    const host = setUp("q-away")
    await withDevice(openDevice(host), async (phone) => {
      const run = host.startElsewhere("while away")
      run.ask(TEA)
      await phone.returns()
      await eventually(() => assert.deepEqual(questionOf(phone), asking), "the question")
    })
  })

  test("a device reloaded while the run waits shows the question again", async () => {
    const host = setUp("q-reload")
    await withDevice(openDevice(host), async (before) => {
      const run = await sendFrom(before, host, "go")
      run.ask(TEA)
      await eventually(() => assert.deepEqual(questionOf(before), asking), "the question first")
    })
    await withDevice(openDevice(host), async (after) => {
      await eventually(() => assert.deepEqual(questionOf(after), asking), "the question again")
    })
  })

  test("a question another device answered goes from the screen without being answered here", async () => {
    const host = setUp("q-taken")
    const run = host.startElsewhere("from the laptop")
    const prompt_id = run.ask(TEA)
    await withDevice(openDevice(host), async (phone) => {
      await eventually(() => assert.deepEqual(questionOf(phone), asking), "the question")
      await answerElsewhere(host.latest.id!, prompt_id, "tea")
      await eventually(() => assert.equal(questionOf(phone), undefined), "the card goes")
      run.finish("Tea it is.")
      await showsEverything(phone, host, "the turn, with the answer the other device gave")
    })
  })
})

test.describe("a run already waiting when the chat opens", () => {
  test("a question the events never carried is read off the run's status", async () => {
    const host = withholding("q-status")
    const run = host.startElsewhere("from the laptop")
    run.ask(TEA)
    await withDevice(openDevice(host), async (phone) => {
      await eventually(
        () => assert.deepEqual(questionOf(phone), asking),
        "the question, read from the run's status",
        200,
      )
      await phone.choose("coffee")
      await eventually(() => assert.equal(host.answers.length, 1), "the host was given the answer")
      run.finish("Coffee it is.")
      await showsEverything(phone, host, "the turn, with the question and its answer")
    })
  })

  test("an approval the events never carried is read off the run's status", async () => {
    const host = withholding("a-status")
    const run = host.startElsewhere("from the laptop")
    run.requestApproval("rm -rf /tmp/x", "delete in root path")
    await withDevice(openDevice(host), async (phone) => {
      await eventually(
        () =>
          assert.deepEqual(phone.waiting().approval, {
            command: "rm -rf /tmp/x",
            choices: ["once", "deny", "session", "always"],
          }),
        "the command, read from the run's status",
        200,
      )
      await phone.approve("deny")
      await eventually(
        () => assert.equal(host.approvals.length, 1),
        "the host was given the choice",
      )
      run.finish("It was denied.")
      await showsEverything(phone, host, "the turn, the denied call counted")
    })
  })

  // The follow ends without the run ending: a phone asleep, a host dropping a slow subscriber, a
  // network that goes. The question is the run's to settle, so the form must outlive the socket.
  test("the stream dies with the question still owed, and the form stays up", async () => {
    const host = withholding("q-drop")
    const run = host.startElsewhere("from the laptop")
    run.ask(TEA)
    await withDevice(openDevice(host, SLOW), async (phone) => {
      await waitingOn(host, phone)
      const read = host.asked.subscriptions
      host.dropConnections()
      await wait(300)
      assert.deepEqual(questionOf(phone), asking, "the form outlives the stream that brought it")
      assert.equal(phone.alert(), undefined, "and nothing says the page failed")
      await eventually(
        () => assert.ok(host.asked.subscriptions > read),
        "the page rejoins the run once its poll comes round",
        1_000,
      )
    })
  })

  test("a stream that breaks mid-read leaves the form up too", async () => {
    const host = withholding("q-break")
    const run = host.startElsewhere("from the laptop")
    run.ask(TEA)
    await withDevice(openDevice(host, SLOW), async (phone) => {
      await waitingOn(host, phone)
      host.breakConnections()
      await wait(300)
      assert.deepEqual(questionOf(phone), asking, "a read that died settles nothing")
    })
  })

  test("a run stopped while the stream is gone takes the form with it", async () => {
    const host = withholding("q-stopped")
    const run = host.startElsewhere("from the laptop")
    run.ask(TEA)
    await withDevice(openDevice(host), async (phone) => {
      await waitingOn(host, phone)
      host.dropConnections()
      await stopElsewhere(host.latest.id!)
      await eventually(
        () => assert.equal(questionOf(phone), undefined),
        "the form goes once the host holds no run",
        1_000,
      )
    })
  })

  test("a message sent while the prompt waits is turned down in the app's own words", async () => {
    const host = withholding("q-send")
    const run = host.startElsewhere("from the laptop")
    run.ask(TEA)
    await withDevice(openDevice(host, SLOW), async (phone) => {
      await waitingOn(host, phone)
      const started = host.asked.runs
      await phone.send("never mind")
      await eventually(
        () => assert.equal(phone.alert(), WAITING_ON_ANSWER),
        "the screen says what the refusal means",
        200,
      )
      assert.equal(host.asked.runs, started, "no turn was started")
      assert.equal(phone.draft(), "", "nothing is handed back to the field")
      assert.deepEqual(
        phone.unsent().map((row) => row.text),
        ["never mind"],
        "the message stays where it was sent, marked not sent",
      )
      assert.deepEqual(questionOf(phone), asking, "the form is still there to answer")
    })
  })
})

test("a refusal that is not a waiting bot keeps the host's own words", async () => {
  const host = setUp("q-blocked")
  await withDevice(openDevice(host, SLOW), async (phone) => {
    const answer = globalThis.fetch
    const said: string[] = []
    const original = toast.error
    toast.error = ((message: unknown) => {
      said.push(String(message))
    }) as typeof toast.error
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) =>
      new URL(String(input)).pathname === "/v1/runs" && init?.method === "POST"
        ? new Response(
            JSON.stringify({
              error: { message: "This workspace is blocked.", code: "workspace_blocked" },
            }),
            { status: 409 },
          )
        : answer(input, init)) as typeof fetch
    try {
      await phone.send("never mind")
      await eventually(
        () => assert.deepEqual(said, ["This workspace is blocked."]),
        "the host's reason is what the screen says",
        200,
      )
      assert.equal(phone.alert(), undefined, "said where the reader is, not above the thread")
      assert.equal(phone.waiting().clarify, undefined, "and no form was put up for it")
    } finally {
      globalThis.fetch = answer
      toast.error = original
    }
  })
})

test.describe("a command that needs approval", () => {
  const COMMAND = "rm -rf /tmp/gots-approval-fixture-does-not-exist"
  const asked = { command: COMMAND, choices: ["once", "deny", "session", "always"] }

  test("the device that sent the turn sees it, denies it, and the run carries on", async () => {
    const host = setUp("a-here")
    await withDevice(openDevice(host), async (phone) => {
      const run = await sendFrom(phone, host, "go")
      run.requestApproval(COMMAND, "delete in root path")
      await eventually(
        () => assert.deepEqual(phone.waiting().approval, asked),
        "the command and its choices",
      )
      await phone.approve("deny")
      await eventually(
        () => assert.deepEqual(host.approvals, [{ run: host.latest.id, choice: "deny" }]),
        "the host was given the answer in the shape it takes",
      )
      await eventually(() => assert.equal(phone.waiting().approval, undefined), "the card goes")
      run.finish("It was denied.")
      await showsEverything(phone, host, "the turn, the denied call counted")
    })
  })

  test("a device that only watches finds it on the run's status and can answer it", async () => {
    const host = setUp("a-watch")
    const run = host.startElsewhere("from the laptop")
    run.requestApproval(COMMAND, "delete in root path")
    await withDevice(openDevice(host), async (phone) => {
      await eventually(
        () => assert.deepEqual(phone.waiting().approval, asked),
        "the command, read from status",
      )
      await phone.approve("once")
      await eventually(
        () => assert.equal(host.approvals.length, 1),
        "the host was given the answer",
      )
      run.finish("It ran.")
      await showsEverything(phone, host, "the turn, with the approved call counted")
    })
  })

  test("a device reloaded while the run waits shows the approval again", async () => {
    const host = setUp("a-reload")
    await withDevice(openDevice(host), async (before) => {
      const run = await sendFrom(before, host, "go")
      run.requestApproval(COMMAND, "delete in root path")
      await eventually(
        () => assert.deepEqual(before.waiting().approval, asked),
        "the command first",
      )
    })
    await withDevice(openDevice(host), async (after) => {
      await eventually(() => assert.deepEqual(after.waiting().approval, asked), "the command again")
    })
  })
})

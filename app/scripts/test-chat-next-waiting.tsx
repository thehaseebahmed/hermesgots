/**
 * A run that waits on the user: a question the agent asked, or a command that needs approval. On
 * Hermes 0.22.5 each is a prompt in the run's status (`pending_controls`) and an event, answered
 * through Hermes's own `POST /v1/runs/{id}/{approval,clarify}` with exactly `{request_id,
 * execution_generation, choice | answer}`. A device that follows the run sees the request arrive on
 * its events; one that only watches finds it on the status, a read that is not a subscription.
 */
import assert from "node:assert/strict"
import test from "node:test"

import { fakeHost, type Ask } from "./chat-next-host.ts"
import {
  eventually,
  openDevice,
  sendFrom,
  showsEverything,
  type Device,
} from "./chat-next-devices.tsx"

const TEA: Ask = {
  question: "Which do you prefer?",
  choices: ["tea", "coffee"],
  multi_select: false,
}
const asking = { text: "Which do you prefer?", choices: ["tea", "coffee"] }

const setUp = (name: string) => {
  const host = fakeHost(`memento-waiting-${name}`, { plugin: true })
  host.install()
  return host
}

/** Another device answering: a request straight to the host, with no screen of ours involved. */
const answerElsewhere = (run: string, prompt_id: string, answer: string) =>
  fetch(`http://hermes.test/v1/runs/${run}/clarify`, {
    method: "POST",
    body: JSON.stringify({ request_id: prompt_id, execution_generation: 1, answer }),
  })

const questionOf = (device: Device) => device.waiting().question

test.describe("a question the agent asked", () => {
  test("the device that sent the turn sees it arrive, answers it, and the run carries on", async () => {
    const host = setUp("q-here")
    const phone = await openDevice(host)
    try {
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
    } finally {
      await phone.close()
    }
  })

  test("a second question after the first replaces the card", async () => {
    const host = setUp("q-two")
    const phone = await openDevice(host)
    try {
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
    } finally {
      await phone.close()
    }
  })

  test("a device that only watches finds it on the run's status and can answer it", async () => {
    const host = setUp("q-watch")
    const run = host.startElsewhere("from the laptop")
    run.ask(TEA)
    const phone = await openDevice(host)
    try {
      await eventually(
        () => assert.deepEqual(questionOf(phone), asking),
        "the question, read from status",
      )
      await phone.choose("coffee")
      await eventually(() => assert.equal(host.answers.length, 1), "the host was given the answer")
      run.finish("Coffee it is.")
      await showsEverything(phone, host, "the turn, with the question and its answer")
    } finally {
      await phone.close()
    }
  })

  test("a device that was away finds the question waiting when it comes back", async () => {
    const host = setUp("q-away")
    const phone = await openDevice(host)
    try {
      const run = host.startElsewhere("while away")
      run.ask(TEA)
      await phone.returns()
      await eventually(() => assert.deepEqual(questionOf(phone), asking), "the question")
    } finally {
      await phone.close()
    }
  })

  test("a device reloaded while the run waits shows the question again", async () => {
    const host = setUp("q-reload")
    const before = await openDevice(host)
    try {
      const run = await sendFrom(before, host, "go")
      run.ask(TEA)
      await eventually(() => assert.deepEqual(questionOf(before), asking), "the question first")
    } finally {
      await before.close()
    }
    const after = await openDevice(host)
    try {
      await eventually(() => assert.deepEqual(questionOf(after), asking), "the question again")
    } finally {
      await after.close()
    }
  })

  test("a question another device answered goes from the screen without being answered here", async () => {
    const host = setUp("q-taken")
    const run = host.startElsewhere("from the laptop")
    const prompt_id = run.ask(TEA)
    const phone = await openDevice(host)
    try {
      await eventually(() => assert.deepEqual(questionOf(phone), asking), "the question")
      await answerElsewhere(host.latest.id!, prompt_id, "tea")
      await eventually(() => assert.equal(questionOf(phone), undefined), "the card goes")
      run.finish("Tea it is.")
      await showsEverything(phone, host, "the turn, with the answer the other device gave")
    } finally {
      await phone.close()
    }
  })
})

test.describe("a command that needs approval", () => {
  const COMMAND = "rm -rf /tmp/gots-approval-fixture-does-not-exist"
  const asked = { command: COMMAND, choices: ["once", "deny", "session", "always"] }

  test("the device that sent the turn sees it, denies it, and the run carries on", async () => {
    const host = setUp("a-here")
    const phone = await openDevice(host)
    try {
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
    } finally {
      await phone.close()
    }
  })

  test("a device that only watches finds it on the run's status and can answer it", async () => {
    const host = setUp("a-watch")
    const run = host.startElsewhere("from the laptop")
    run.requestApproval(COMMAND, "delete in root path")
    const phone = await openDevice(host)
    try {
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
    } finally {
      await phone.close()
    }
  })

  test("a device reloaded while the run waits shows the approval again", async () => {
    const host = setUp("a-reload")
    const before = await openDevice(host)
    try {
      const run = await sendFrom(before, host, "go")
      run.requestApproval(COMMAND, "delete in root path")
      await eventually(
        () => assert.deepEqual(before.waiting().approval, asked),
        "the command first",
      )
    } finally {
      await before.close()
    }
    const after = await openDevice(host)
    try {
      await eventually(() => assert.deepEqual(after.waiting().approval, asked), "the command again")
    } finally {
      await after.close()
    }
  })
})

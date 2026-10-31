/**
 * A message a send couldn't get to the host stays in the thread, in the app's own not-sent shape:
 * after the last turn rather than inside one, with the files it was sent with, Retry and Cancel,
 * kept on this device across a reopen, and gone for good once it is sent or taken back (ADR 0071).
 * The look and the two controls are the current screen's (`failed-send`); what is chat-next's is
 * where the row stands and that it is this device's own row, not a turn.
 */
import assert from "node:assert/strict"
import test from "node:test"
import { toast } from "sonner"

import type { Unsent } from "@/lib/db"
import { fakeHost } from "./chat-next-host.ts"
import { eventually, openDevice, showsEverything, turn, wait, withDevice } from "./chat-next-devices.tsx"
import { json } from "./component-kit.tsx"

/**
 * Holds every run start for `ms` before letting it through, so a screen can be caught mid-send: the
 * row a retry is sent from must still be there while the host has not answered.
 */
function holdSends(ms: number) {
  const answer = globalThis.fetch
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    if (init?.method === "POST" && new URL(String(input)).pathname === "/v1/runs") {
      await new Promise((done) => setTimeout(done, ms))
    }
    return answer(input, init)
  }) as typeof fetch
  return () => {
    globalThis.fetch = answer
  }
}

/**
 * Every run start is answered the way `why` says — a browser that can't reach the host throws as one
 * that is away does, and a host that turns the turn down answers with its own reason. Every other
 * request goes to the host as it always would.
 */
function refuseSends(why: "away" | string) {
  const answer = globalThis.fetch
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    if (init?.method === "POST" && new URL(String(input)).pathname === "/v1/runs") {
      if (why === "away") throw new TypeError("Failed to fetch")
      return json({ error: { message: why } }, 429)
    }
    return answer(input, init)
  }) as typeof fetch
  return () => {
    globalThis.fetch = answer
  }
}

test("a message that didn't go is drawn at the end of the flow, not inside a turn", async () => {
  const host = fakeHost("memento-unsent-end")
  const device = await openDevice(host)
  try {
    await turn(device, host, "the first ask", "The first answer.")
    await showsEverything(device, host, "the first turn")
    await turn(device, host, "the second ask", "The second answer.")
    await showsEverything(device, host, "the second turn")
    assert.deepEqual(device.unsent(), [], "a thread with nothing unsent draws nothing extra")
    const drawn = device.turns()

    const answer = refuseSends("away")
    try {
      await device.send("this one doesn't go")
      await eventually(
        () => assert.deepEqual(device.unsent().map((row) => row.text), ["this one doesn't go"]),
        "the message to be kept in the thread",
      )
    } finally {
      answer()
    }

    assert.deepEqual(device.turns(), drawn, "the turns are as they were")
    assert.equal(device.unsent()[0].inTurn, false, "drawn after the last turn, not inside one")
    assert.equal(device.unsent()[0].state, "Not sent", "marked as one that didn't go")
    assert.equal(device.unsent()[0].retry, true, "with Retry")
    assert.equal(device.unsent()[0].cancel, true, "and Cancel")
    assert.equal(device.draft(), "", "the words are out of the field")
    await showsEverything(device, host, "the host's own turns")
  } finally {
    await device.close()
  }
})

test("two messages that didn't go keep the order they were sent in", async () => {
  const host = fakeHost("memento-unsent-order")
  const device = await openDevice(host)
  try {
    await turn(device, host, "an ask", "An answer.")
    const answer = refuseSends("away")
    try {
      await device.send("first that didn't go")
      await eventually(
        () => assert.equal(device.unsent().length, 1),
        "the first message to be kept",
      )
      await wait(20)
      await device.send("second that didn't go")
      await eventually(
        () => assert.equal(device.unsent().length, 2),
        "the second message to be kept",
      )
    } finally {
      answer()
    }
    assert.deepEqual(
      device.unsent().map((row) => row.text),
      ["first that didn't go", "second that didn't go"],
      "in the order they were sent",
    )
    assert.deepEqual(
      device.unsent().map((row) => row.retry && row.cancel),
      [true, true],
      "each with its own two controls",
    )
  } finally {
    await device.close()
  }
})

test("taking a message back removes it, and its words don't come back to the field", async () => {
  const host = fakeHost("memento-unsent-cancel")
  const device = await openDevice(host)
  try {
    const answer = refuseSends("away")
    try {
      await device.send("never mind this one")
      await eventually(
        () => assert.equal(device.unsent().length, 1),
        "the message to be kept",
      )
    } finally {
      answer()
    }
    await device.cancel("never mind this one")
    await eventually(() => assert.deepEqual(device.unsent(), []), "the row to leave the thread")
    assert.equal(device.draft(), "", "and nothing of it in the field")
  } finally {
    await device.close()
  }
})

test("a message that didn't go outlives a reopen", async () => {
  const host = fakeHost("memento-unsent-reload")
  const first = await openDevice(host)
  await turn(first, host, "an ask", "An answer.")
  await showsEverything(first, host, "the turn")
  // A send nothing answered: the row it leaves behind is the one the device must find on the way back.
  const answer = refuseSends("away")
  try {
    await first.send("log the whole disk")
    await eventually(
      () => assert.deepEqual(first.unsent().map((one) => one.text), ["log the whole disk"]),
      "the message to be kept in the thread",
    )
  } finally {
    answer()
  }
  // Kept by the device, not only drawn by it: the record the chat writes carries the row.
  await eventually(
    async () => {
      const kept = await first.database.sessionStates.get(host.session)
      assert.deepEqual(kept?.unsent?.map((one) => one.text), ["log the whole disk"])
    },
    "the message to be written down with the chat",
  )
  await first.close()

  await withDevice(openDevice(host, { database: first.database }), async (again) => {
    await eventually(
      () => assert.deepEqual(again.unsent().map((one) => one.text), ["log the whole disk"]),
      "the message to be drawn again from the device",
    )
    assert.equal(again.unsent()[0].state, "Not sent", "still marked as one that didn't go")
    assert.equal(again.unsent()[0].retry, true, "with Retry")
    assert.equal(again.unsent()[0].cancel, true, "and Cancel")
  })
})

test("a message sent again stays in its row until the host takes it", async () => {
  const host = fakeHost("memento-unsent-until-taken")
  const device = await openDevice(host)
  try {
    await turn(device, host, "an ask", "An answer.")
    const refused = refuseSends("away")
    try {
      await device.send("this one doesn't go")
      await eventually(
        () => assert.equal(device.unsent().length, 1),
        "the message to be kept",
      )
    } finally {
      refused()
    }

    const hold = holdSends(400)
    try {
      await device.retry("this one doesn't go")
      await wait(150)
      assert.equal(device.unsent().length, 1, "the row is still there while the host has not answered")
      assert.equal(device.unsent()[0].text, "this one doesn't go", "with its words")
    } finally {
      hold()
    }
    await eventually(
      () => assert.equal(device.unsent().length, 0),
      "the row to leave once the host has taken the message",
    )
  } finally {
    await device.close()
  }
})

test("a message that didn't go keeps the files it was sent with", async () => {
  const host = fakeHost("memento-unsent-files")
  const row: Unsent = {
    id: "unsent-1",
    text: "look at this",
    attachments: [{ name: "photo.png", type: "image/png", size: 12, image: true }],
    at: Date.now() - 1_000,
  }
  const device = await openDevice(host)
  await turn(device, host, "an ask", "An answer.")
  await device.database.sessionStates.put({ session: host.session, unsent: [row] })
  try {
    await eventually(
      () => assert.deepEqual(device.unsent().map((one) => one.text), ["look at this"]),
      "the message to be drawn from the device",
    )
    assert.equal(device.unsent()[0].files, "photo.png", "with the file it was sent with")
    assert.equal(device.unsent()[0].retry, true, "and Retry, to send it again with it")
  } finally {
    await device.close()
  }
})

test("a retry that fails again leaves the row exactly where it was", async () => {
  const host = fakeHost("memento-unsent-retry-fails")
  const device = await openDevice(host)
  try {
    await turn(device, host, "an ask", "An answer.")
    const answer = refuseSends("away")
    try {
      await device.send("try me twice")
      await eventually(() => assert.equal(device.unsent().length, 1), "the message to be kept")
      await device.retry("try me twice")
      await eventually(
        () => assert.equal(device.unsent().length, 1),
        "the retried message to be kept again, once it fails",
      )
    } finally {
      answer()
    }
    assert.deepEqual(
      device.unsent().map(({ text, state, retry, cancel }) => ({ text, state, retry, cancel })),
      [{ text: "try me twice", state: "Not sent", retry: true, cancel: true }],
      "still the one row, and nothing sends it by itself",
    )
  } finally {
    await device.close()
  }
})

test("a host that turns a send down keeps the message, and says why where the reader is", async () => {
  const REFUSAL = "Rate limit exceeded. Try again in a few seconds."
  const host = fakeHost("memento-unsent-refused")
  const device = await openDevice(host)
  const said: string[] = []
  const original = toast.error
  toast.error = ((message: unknown) => {
    said.push(String(message))
  }) as typeof toast.error
  try {
    const answer = refuseSends(REFUSAL)
    try {
      await device.send("this one is refused")
      await eventually(
        () => assert.equal(device.unsent().length, 1),
        "the refused message to be kept",
      )
    } finally {
      answer()
    }
    assert.equal(device.unsent()[0].state, "Not sent", "marked as one that didn't go")
    assert.deepEqual(
      said,
      [REFUSAL],
      "the host's reason is said once, the way every request here that came back with an error is",
    )
    assert.equal(
      device.alert(),
      undefined,
      "and not left as the thread's first line, above the viewport of a thread that scrolls",
    )
    assert.doesNotMatch(
      device.unsent()[0].text + device.unsent()[0].state,
      /Rate limit/,
      "and is never repeated under the message",
    )
  } finally {
    toast.error = original
    await device.close()
  }
})

test("a send the host never answers says what is known, not what a failed read says", async () => {
  const host = fakeHost("memento-unsent-unanswered")
  const device = await openDevice(host)
  const said: string[] = []
  const original = toast.error
  toast.error = ((message: unknown) => {
    said.push(String(message))
  }) as typeof toast.error
  try {
    const answer = refuseSends("away")
    try {
      await device.send("this one gets no answer")
      await eventually(
        () => assert.equal(device.unsent().length, 1),
        "the unanswered message to be kept",
      )
    } finally {
      answer()
    }
    // The reads still land, so this is not an away host: the chat's header keeps its own subject and
    // the send is the only thing that failed.
    assert.deepEqual(said, ["This host didn't take the message."], "what the app knows is said")
    assert.equal(device.away(), false, "the host is not called away by a send that failed")
    assert.equal(device.alert(), undefined, "and nothing is drawn above the thread")
  } finally {
    toast.error = original
    await device.close()
  }
})

test("a chat another surface owns is said in words, not as the host's code", async () => {
  // Hermes refuses a run on a session another surface owns ("API sessions are their own sessions"),
  // and names it with a code: `permission_denied`. The row keeps the message; the reader gets a
  // sentence and the one way out.
  const host = fakeHost("memento-unsent-elsewhere")
  const device = await openDevice(host)
  const said: string[] = []
  const original = toast.error
  toast.error = ((message: unknown) => {
    said.push(String(message))
  }) as typeof toast.error
  const answer = globalThis.fetch
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) =>
    new URL(String(input)).pathname === "/v1/runs" && init?.method === "POST"
      ? json({ error: { code: "permission_denied", message: "permission_denied" } }, 409)
      : answer(input, init)) as typeof fetch
  try {
    await device.send("this one belongs to another surface")
    await eventually(
      () => assert.equal(device.unsent().length, 1),
      "the message to be kept in the thread",
    )
    assert.deepEqual(
      said,
      [
        "This chat's session belongs to another Hermes surface, so it can't be carried on here. Start a new chat.",
      ],
      "the code is turned into what it means and what to do",
    )
  } finally {
    globalThis.fetch = answer
    toast.error = original
    await device.close()
  }
})

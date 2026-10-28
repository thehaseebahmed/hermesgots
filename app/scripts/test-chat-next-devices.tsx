/**
 * One chat, several devices: every device that looks at it must draw all of it, whichever way it
 * came to hold the chat. What each must show is what the host authored (`chat-next-host.ts`).
 */
import test from "node:test"

import { fakeHost } from "./chat-next-host.ts"
import { openDevice, showsEverything, turn, withDevice } from "./chat-next-devices.tsx"

test("1: a chat left open on the device that started it shows every turn it made", async () => {
  const host = fakeHost("memento-one")
  await withDevice(openDevice(host), async (phone) => {
    await turn(phone, host, "first question", "The first answer.")
    await turn(phone, host, "second question", "The second answer.", 3)
    await showsEverything(phone, host, "both turns, with their calls, on the device that made them")
  })
})

test("2: a device that never held the chat shows all of it, however long it has grown", async () => {
  const host = fakeHost("memento-two")
  // Thirty turns of six rows each: far more than the one page of fifty the host answers with.
  host.seed(
    Array.from({ length: 30 }, (_, at) => ({
      user: `question ${at}`,
      tools: 2,
      reply: `answer ${at}`,
    })),
  )
  await withDevice(openDevice(host), async (laptop) => {
    await showsEverything(laptop, host, "every turn, the oldest ones included")
  })
})

test("3: a chat continued on another device is whole again when the first device comes back", async () => {
  const host = fakeHost("memento-three")
  const phone = await openDevice(host)
  const laptop = await openDevice(host)
  try {
    await turn(phone, host, "started on the phone", "Answered for the phone.")
    await showsEverything(phone, host, "the phone shows its own turn")

    await laptop.returns()
    await turn(laptop, host, "continued on the laptop", "Answered for the laptop.", 2)
    await showsEverything(laptop, host, "the laptop shows the whole chat, the phone's turn too")

    await phone.returns()
    await showsEverything(phone, host, "the phone, back in the foreground, shows the laptop's turn")
  } finally {
    await laptop.close()
    await phone.close()
  }
})

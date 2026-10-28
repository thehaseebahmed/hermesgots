/**
 * One chat, several devices: every device that looks at it must draw all of it, whichever way it
 * came to hold the chat. A device here is its own mount of the page with its own state; the host
 * is the only thing they share (`chat-next-host.ts`), and what it authored is what each must show.
 *
 * The contract the page is held to, beyond what slice 1 drew: a composer (`[data-composer]`, its
 * send button `[data-send]`), a turn is a `main > section`, and a device that comes back to the
 * foreground (`visibilitychange`) reads the chat again.
 */
import assert from "node:assert/strict"
import test from "node:test"
import { act } from "react"
import { createRoot } from "react-dom/client"
import { MemoryRouter, Route, Routes } from "react-router"

import { ChatNextPage } from "@/chat-next/page"
import { click, settle, type } from "./component-kit.tsx"
import { fakeHost, type ExpectedTurn } from "./chat-next-host.ts"

type Host = ReturnType<typeof fakeHost>

async function openDevice(host: Host) {
  const container = document.createElement("div")
  document.body.append(container)
  const root = createRoot(container)
  const query = `server=${encodeURIComponent("http://hermes.test")}&key=k&session=${host.session}`
  await act(async () =>
    root.render(
      <MemoryRouter initialEntries={[`/next?${query}`]}>
        <Routes>
          <Route path="/next" element={<ChatNextPage />} />
        </Routes>
      </MemoryRouter>,
    ),
  )
  await settle()
  const one = (selector: string) => container.querySelector(selector)
  return {
    turns: (): ExpectedTurn[] =>
      [...container.querySelectorAll("main > section")].map((section) => ({
        user: section.querySelector("[data-user]")?.textContent ?? "",
        texts: [...section.querySelectorAll("[data-text]")].map((text) => text.textContent ?? ""),
        tools: [...section.querySelectorAll("[data-tools]")]
          .map((line) => Number(/^(\d+) tool/.exec(line.textContent ?? "")?.[1] ?? 0))
          .reduce((sum, count) => sum + count, 0),
      })),
    async send(text: string) {
      await type(one("[data-composer]"), text)
      await click(one("[data-send]"))
    },
    async returns() {
      await act(async () => void document.dispatchEvent(new Event("visibilitychange")))
      await settle()
    },
    async close() {
      await act(async () => root.unmount())
      container.remove()
    },
  }
}

type Device = Awaited<ReturnType<typeof openDevice>>

/** Gives a device the moment it needs to draw what it was told, then holds it to the host's word. */
async function showsEverything(device: Device, host: Host, what: string) {
  for (let tries = 0; tries < 40; tries++) {
    try {
      assert.deepEqual(device.turns(), host.expected)
      break
    } catch {
      await act(async () => new Promise((resolve) => setTimeout(resolve, 25)))
    }
  }
  assert.deepEqual(device.turns(), host.expected, what)
}

/** Sends from a device and plays the host's side of the turn: calls, streamed words, the reply. */
async function turn(device: Device, host: Host, user: string, reply: string, tools = 1) {
  const before = host.asked.runs
  await device.send(user)
  for (let tries = 0; host.asked.runs === before && tries < 40; tries++)
    await act(async () => new Promise((resolve) => setTimeout(resolve, 25)))
  assert.equal(host.asked.runs, before + 1, `the host was asked to run "${user}"`)
  const run = host.latest.run!
  for (let at = 0; at < tools; at++) run.tool("terminal", `echo ${at}`, '{"exit_code": 0}')
  run.say(`\n\n${reply.slice(0, 4)}`)
  run.say(reply.slice(4))
  run.finish(reply)
  await settle()
}

test("1: a chat left open on the device that started it shows every turn it made", async () => {
  const host = fakeHost("memento-one")
  host.install()
  const phone = await openDevice(host)
  try {
    await turn(phone, host, "first question", "The first answer.")
    await turn(phone, host, "second question", "The second answer.", 3)
    await showsEverything(phone, host, "both turns, with their calls, on the device that made them")
  } finally {
    await phone.close()
  }
})

test("2: a device that never held the chat shows all of it, however long it has grown", async () => {
  const host = fakeHost("memento-two")
  host.install()
  // Thirty turns of six rows each: far more than the one page of fifty the host answers with.
  host.seed(
    Array.from({ length: 30 }, (_, at) => ({
      user: `question ${at}`,
      tools: 2,
      reply: `answer ${at}`,
    })),
  )
  const laptop = await openDevice(host)
  try {
    await showsEverything(laptop, host, "every turn, the oldest ones included")
  } finally {
    await laptop.close()
  }
})

test("3: a chat continued on another device is whole again when the first device comes back", async () => {
  const host = fakeHost("memento-three")
  host.install()
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

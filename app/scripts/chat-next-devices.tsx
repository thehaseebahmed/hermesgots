/**
 * What the chat-next tests drive a device with. A device is its own mount of the page with its own
 * state; the host (`chat-next-host.ts`) is the only thing devices share.
 *
 * The contract the page is held to: a composer (`[data-composer]`, its send button `[data-send]`),
 * a turn is a `main > section`, and a device that comes back to the foreground (`visibilitychange`)
 * reads the chat again.
 */
import assert from "node:assert/strict"
import { act } from "react"
import { createRoot } from "react-dom/client"
import { MemoryRouter, Route, Routes } from "react-router"

import { ChatNextPage } from "@/chat-next/page"
import { click, settle, type } from "./component-kit.tsx"
import { fakeHost, type ExpectedTurn } from "./chat-next-host.ts"

export type Host = ReturnType<typeof fakeHost>

const wait = (ms: number) => act(async () => new Promise((resolve) => setTimeout(resolve, ms)))

export async function openDevice(host: Host) {
  const container = document.createElement("div")
  document.body.append(container)
  const root = createRoot(container)
  const query = `server=${encodeURIComponent("http://hermes.test")}&key=k&session=${host.session}`
  await act(async () =>
    root.render(
      <MemoryRouter initialEntries={[`/next?${query}`]}>
        <Routes>
          <Route path="/next" element={<ChatNextPage pollMs={20} idleMs={20} />} />
        </Routes>
      </MemoryRouter>,
    ),
  )
  await settle()
  const one = (selector: string) => container.querySelector(selector)
  return {
    /** The notice an unsupported host is given in place of the chat. */
    notice: () => one("[data-unsupported]")?.textContent ?? undefined,
    composer: () => Boolean(one("[data-composer]")),
    turns: (): ExpectedTurn[] =>
      [...container.querySelectorAll("main > section")].map((section) => ({
        user: section.querySelector("[data-user]")?.textContent ?? "",
        texts: [...section.querySelectorAll("[data-text]")].map((text) => text.textContent ?? ""),
        tools: [...section.querySelectorAll("[data-tools]")]
          .map((line) => Number(/^(\d+) tool/.exec(line.textContent ?? "")?.[1] ?? 0))
          .reduce((sum, count) => sum + count, 0),
        asks: [...section.querySelectorAll("[data-answered]")].map((ask) => ask.textContent ?? ""),
      })),
    /** What the screen is waiting on the user for, as a card with its words and its buttons. */
    waiting: () => {
      const question = one("[data-question]")
      const approval = one("[data-approval]")
      return {
        question: question
          ? {
              text: question.querySelector("[data-question-text]")?.textContent ?? "",
              choices: [...question.querySelectorAll("[data-choice]")].map(
                (c) => c.textContent ?? "",
              ),
            }
          : undefined,
        approval: approval
          ? {
              command: approval.querySelector("[data-command]")?.textContent ?? "",
              choices: [...approval.querySelectorAll("[data-approve]")].map(
                (button) => button.getAttribute("data-approve") ?? "",
              ),
            }
          : undefined,
      }
    },
    async choose(choice: string) {
      const button = [...container.querySelectorAll("[data-choice]")].find(
        (one) => one.textContent === choice,
      )
      await click(button ?? null)
    },
    async approve(choice: string) {
      await click(one(`[data-approve="${choice}"]`))
    },
    async send(text: string) {
      await type(one("[data-composer]"), text)
      await click(one("[data-send]"))
    },
    /** The device goes to the background and the page comes back to the foreground. */
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

export type Device = Awaited<ReturnType<typeof openDevice>>

/** Gives a device the moment it needs to draw what it was told, then holds it to the host's word. */
export async function showsEverything(device: Device, host: Host, what: string) {
  for (let tries = 0; tries < 60; tries++) {
    try {
      assert.deepEqual(device.turns(), host.expected)
      break
    } catch {
      await wait(25)
    }
  }
  assert.deepEqual(
    device.turns(),
    host.expected,
    `${what}\n  device:   ${JSON.stringify(device.turns())}\n  expected: ${JSON.stringify(host.expected)}`,
  )
}

/** Sends from a device and waits for the host to be asked, returning the run it started. */
export async function sendFrom(device: Device, host: Host, user: string) {
  const before = host.asked.runs
  await device.send(user)
  for (let tries = 0; host.asked.runs === before && tries < 60; tries++) await wait(25)
  assert.equal(host.asked.runs, before + 1, `the host was asked to run "${user}"`)
  return host.latest.run!
}

/** A whole turn sent from a device and played out by the host: calls, streamed words, the reply. */
export async function turn(device: Device, host: Host, user: string, reply: string, tools = 1) {
  const run = await sendFrom(device, host, user)
  for (let at = 0; at < tools; at++) run.tool("terminal", `echo ${at}`, '{"exit_code": 0}')
  run.say(`\n\n${reply.slice(0, 4)}`)
  run.say(reply.slice(4))
  run.finish(reply)
  await settle()
}

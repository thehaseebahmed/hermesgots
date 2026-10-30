/**
 * What the chat-next tests drive a device with. A device is its own mount of the page with its own
 * state; the host (`chat-next-host.ts`) is the only thing devices share.
 *
 * Each device keeps its own database, as each device in the world does (ADR 0065); a reload is the
 * page opened again on the same one (`{ database: device.database }`).
 *
 * The contract the page is held to: a composer (`[data-composer]`, its send button `[data-send]`),
 * a turn is a `main > section`, and a device that comes back to the foreground (`visibilitychange`)
 * reads the chat again.
 */
import Dexie from "dexie"
import assert from "node:assert/strict"
import { act } from "react"
import { createRoot } from "react-dom/client"
import { MemoryRouter, Route, Routes } from "react-router"

import { ChatNextPage } from "@/chat-next/page"
import { SESSION_STORES, type SessionDb } from "@/lib/db"
import { click, settle, type } from "./component-kit.tsx"
import { fakeHost, type ExpectedTurn } from "./chat-next-host.ts"

export type Host = ReturnType<typeof fakeHost>

export const wait = (ms: number) =>
  act(async () => new Promise((resolve) => setTimeout(resolve, ms)))

/**
 * Retries a throwing check while the page settles, and lets it fail with its own message at the end.
 * `tries` widens the wait for a claim that costs the page more than the one read a poll makes, such
 * as a wait recovered from a second read of the run.
 */
export async function eventually(check: () => void, what: string, tries = 60) {
  for (let attempt = 0; attempt < tries; attempt++) {
    try {
      return check()
    } catch {
      await wait(25)
    }
  }
  check()
  assert.fail(what)
}

/**
 * A device is polled at `pollMs` while the page is busy (20ms), and while idle at `idleMs`, which is
 * as fast by default so a test needs no waiting. A test about what keeps the page busy gives it a
 * slow one, so that only the busy poll can have done the reading; one about what the page says until
 * its next read gives both a slow one, so the answer is not taken back before it is looked at.
 */
let devices = 0

/** A database of the device's own, holding only what chat-next keeps. */
export function deviceDatabase(): SessionDb {
  const database = new Dexie(`chat-next-device-${++devices}`) as SessionDb
  database.version(1).stores(SESSION_STORES)
  return database
}

export async function openDevice(
  host: Host,
  {
    pollMs = 20,
    idleMs = 20,
    database = deviceDatabase(),
  }: { pollMs?: number; idleMs?: number; database?: SessionDb } = {},
) {
  const container = document.createElement("div")
  document.body.append(container)
  const root = createRoot(container)
  const query = `server=${encodeURIComponent("http://hermes.test")}&key=k&session=${host.session}`
  await act(async () =>
    root.render(
      <MemoryRouter initialEntries={[`/next?${query}`]}>
        <Routes>
          <Route
            path="/next"
            element={<ChatNextPage pollMs={pollMs} idleMs={idleMs} database={database} />}
          />
        </Routes>
      </MemoryRouter>,
    ),
  )
  await settle()
  const one = (selector: string) => container.querySelector(selector)
  return {
    database,
    composer: () => Boolean(one("[data-composer]")),
    /** What the page says went wrong, in the words the plain view draws it in. */
    alert: () => one("[role=alert]")?.textContent ?? undefined,
    /** The words the composer holds, as a send that never landed hands them back. */
    draft: () => (one("[data-composer]") as HTMLTextAreaElement | null)?.value ?? undefined,
    /** Whether the thread says it is catching up, as the first read of it is still out. */
    catching: () => Boolean(one("[data-catching-up]")),
    /** The line a host that can't be reached is given, over what the device holds. */
    away: () => Boolean(one("[data-away]")),
    turns: (): ExpectedTurn[] =>
      [...container.querySelectorAll("main > section")].map((section) => ({
        user: section.querySelector("[data-user]")?.textContent ?? "",
        texts: [...section.querySelectorAll("[data-text]")].map((text) => text.textContent ?? ""),
        tools: [...section.querySelectorAll("[data-tools]")]
          .map((line) => Number(/^(\d+) tool/.exec(line.textContent ?? "")?.[1] ?? 0))
          .reduce((sum, count) => sum + count, 0),
        asks: [...section.querySelectorAll("[data-answered]")].map((ask) => ask.textContent ?? ""),
        seams: section.querySelectorAll("[data-compaction]").length,
        agents: [...section.querySelectorAll("[data-agent]")].map((card) => ({
          goal: card.querySelector("[data-agent-goal]")?.textContent ?? "",
          status: card.getAttribute("data-status") ?? "",
        })),
      })),
    /** The line a wake turn opens with, saying which subagent's finish it answers. */
    wakes: () =>
      [...container.querySelectorAll("main > section [data-wake]")].map(
        (note) => note.textContent ?? "",
      ),
    /** The child's own thread, once a card has been opened. */
    thread: () => {
      const open = one("[data-agent-thread]")
      return open
        ? [...open.querySelectorAll("section")].map((section) => ({
            user: section.querySelector("[data-user]")?.textContent ?? "",
            texts: [...section.querySelectorAll("[data-text]")].map(
              (text) => text.textContent ?? "",
            ),
          }))
        : undefined
    },
    /** The turns' own elements, which stay the same ones while the turns around them change. */
    sections: () => [...container.querySelectorAll("main > section")],
    /** What the screen says of the older pages: being read, or failed; nothing where it says nothing. */
    older: () => one("[data-older]")?.getAttribute("data-older") ?? undefined,
    async retryOlder() {
      await click(one("[data-older-retry]"))
      await settle()
    },
    /** Whether the screen offers the messages a compaction took out of the transcript. */
    offersEarlier: () => Boolean(one("[data-earlier]")),
    async loadEarlier() {
      await click(one("[data-earlier]"))
      await settle()
    },
    async openAgent(goal: string) {
      const card = [...container.querySelectorAll("[data-agent]")].find(
        (one) => one.querySelector("[data-agent-goal]")?.textContent === goal,
      )
      await click(card?.querySelector("[data-open-agent]") ?? null)
    },
    async closeAgent() {
      await click(one("[data-close-agent]"))
    },
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

/** Runs `run` with a device that is closed however it ends. */
export async function withDevice<T>(
  open: Promise<Device>,
  run: (device: Device) => Promise<T> | T,
) {
  const device = await open
  try {
    return await run(device)
  } finally {
    await device.close()
  }
}

/** Gives a device the moment it needs to draw what it was told, then holds it to the host's word. */
export async function showsEverything(device: Device, host: Host, what: string, full = false) {
  const expected = () => host.view(full)
  for (let tries = 0; tries < 60; tries++) {
    try {
      assert.deepEqual(device.turns(), expected())
      break
    } catch {
      await wait(25)
    }
  }
  assert.deepEqual(
    device.turns(),
    expected(),
    `${what}\n  device:   ${JSON.stringify(device.turns())}\n  expected: ${JSON.stringify(expected())}`,
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

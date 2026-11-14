/**
 * A posed bot (Crumb): drawn still it is its happy pose, drawn with `animate` it shows the pose its
 * mood names and changes between moods in a poof — and with no motion asked for, or while moods
 * arrive faster than a poof, it still ends on the newest one. A bot with one picture ignores mood.
 */
import assert from "node:assert/strict"
import { existsSync } from "node:fs"
import test from "node:test"
import { act } from "react"

const { Bot } = await import("@/components/bot")
const { BOTS, BOT_MOODS, botImage } = await import("@/components/bots")
import type { BotMood } from "@/components/bots"
const { mount, spyAnimate, until, withReducedMotion } = await import("./component-kit.tsx")

const crumb = BOTS.find((bot) => bot.id === "crumb")!
const src = () => document.querySelector("img")?.getAttribute("src")

test("every mood has a pose and the still is the happy one", () => {
  assert.ok(crumb.posed)
  assert.equal(botImage(crumb), "/bots/crumb/happy.png")
  assert.deepEqual(
    BOT_MOODS.map((one) => botImage(crumb, one.id)),
    BOT_MOODS.map((one) => `/bots/crumb/${one.id}.png`),
  )
  assert.equal(botImage({ id: "tri" }, "sleepy"), "/bots/tri.png", "a one-picture bot has no poses")
})

test("every posed bot has a pose file for every mood", () => {
  const posed = BOTS.filter((bot) => bot.posed)
  assert.ok(posed.length > 0)
  for (const bot of posed)
    for (const { id } of BOT_MOODS)
      assert.ok(
        existsSync(new URL(`../public${botImage(bot, id)}`, import.meta.url)),
        `${bot.id} has no ${id} pose`,
      )
})

test("a still posed bot is its happy pose whatever mood it is given", async () => {
  await mount(<Bot id="crumb" mood="sleepy" />, async () => {
    assert.equal(src(), "/bots/crumb/happy.png")
  })
})

test("a bot with one picture ignores mood", async () => {
  await mount(<Bot id="tri" animate mood="sleepy" />, async () => {
    assert.equal(src(), "/bots/tri.png")
  })
})

/** Crumb drawn into a root of its own, so a case can hand it one mood after another. */
async function withCrumb(
  body: (draw: (mood: BotMood) => Promise<void>, root: HTMLElement) => Promise<void>,
) {
  const container = document.createElement("div")
  document.body.append(container)
  const { createRoot } = await import("react-dom/client")
  const root = createRoot(container)
  try {
    await body(
      (mood) => act(async () => root.render(<Bot id="crumb" animate mood={mood} />)),
      container,
    )
  } finally {
    await act(async () => root.unmount())
    container.remove()
  }
}

const poseOf = (root: HTMLElement) => root.querySelector("img")?.getAttribute("src")

test("an animated posed bot draws the pose its mood names, and poofs to the next", async () => {
  await withCrumb(async (draw, root) => {
    await draw("wave")
    assert.equal(poseOf(root), "/bots/crumb/wave.png")
    assert.equal(root.querySelector("img")?.getAttribute("data-mood"), "wave")
    const spy = spyAnimate()
    try {
      await draw("love")
      await until(async () => poseOf(root) === "/bots/crumb/love.png", "the pose to change")
      const frames = spy.asked.flatMap((one) =>
        one.keyframes.map((frame) => String(frame.transform)),
      )
      assert.ok(
        frames.some((t) => t.includes("scale(0)")),
        "it shrinks away",
      )
      assert.ok(
        frames.some((t) => t.includes("scale(1.1)")),
        "it pops back in",
      )
      assert.equal(root.querySelectorAll("[aria-hidden] span").length, 0, "the smoke is gone")
    } finally {
      spy.restore()
    }
  })
})

test("moods asked for while one is changing end on the newest", async () => {
  await withCrumb(async (draw, root) => {
    for (const mood of ["happy", "love", "curious", "sleepy"] as const) await draw(mood)
    await until(async () => poseOf(root) === "/bots/crumb/sleepy.png", "the newest mood")
  })
})

test("with no motion asked for the pose changes at once, with no smoke", async () => {
  await withReducedMotion(async () => {
    await withCrumb(async (draw, root) => {
      await draw("happy")
      const spy = spyAnimate()
      try {
        await draw("curious")
        await until(async () => poseOf(root) === "/bots/crumb/curious.png", "the pose to change")
        assert.equal(spy.asked.length, 0)
      } finally {
        spy.restore()
      }
    })
  })
})

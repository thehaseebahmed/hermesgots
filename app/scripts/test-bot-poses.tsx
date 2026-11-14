/**
 * A posed bot (Crumb): drawn still it is its happy pose, drawn with `animate` it shows the pose its
 * mood names and changes between moods in a poof — the new pose swapped in over the old one
 * (transitions.dev's icon swap), the body's squash and a puff of smoke (its like button's pop and
 * burst) — and with no motion asked for, or while moods arrive faster than a poof, it still ends on
 * the newest one. A bot with one picture ignores mood.
 */
import assert from "node:assert/strict"
import { existsSync } from "node:fs"
import test from "node:test"
import { act } from "react"

const { Bot } = await import("@/components/bot")
const { BOTS, BOT_MOODS, LEGACY_BOT_IDS, botIdOf, botImage } = await import("@/components/bots")
import type { BotMood } from "@/components/bots"
const { mount, until, withReducedMotion } = await import("./component-kit.tsx")

const crumb = BOTS.find((bot) => bot.id === "crumb")!
const src = () => document.querySelector("img")?.getAttribute("src")

test("every mood has a pose and the still is the happy one", () => {
  assert.equal(botImage(crumb), "/bots/crumb/happy.png")
  assert.deepEqual(
    BOT_MOODS.map((one) => botImage(crumb, one.id)),
    BOT_MOODS.map((one) => `/bots/crumb/${one.id}.png`),
  )
})

test("every bot has a pose file for every mood", () => {
  assert.ok(BOTS.length > 0)
  for (const bot of BOTS)
    for (const { id } of BOT_MOODS)
      assert.ok(
        existsSync(new URL(`../public${botImage(bot, id)}`, import.meta.url)),
        `${bot.id} has no ${id} pose`,
      )
})

test("a still bot is its happy pose whatever mood it is given", async () => {
  await mount(<Bot id="crumb" mood="sleepy" />, async () => {
    assert.equal(src(), "/bots/crumb/happy.png")
  })
})

test("every retired id maps onto a bot that exists, in one step", () => {
  const ids = new Set(BOTS.map((bot) => bot.id))
  for (const [old, now] of Object.entries(LEGACY_BOT_IDS)) {
    assert.ok(ids.has(now), `${old} maps to ${now}, which is no bot`)
    assert.ok(!ids.has(old), `${old} is retired but still a bot`)
    assert.equal(botIdOf(old), now)
  }
  assert.equal(botIdOf("crumb"), "crumb", "a current id is itself")
})

test("the retired characters map onto distinct new ones, so a device's bots stay apart", () => {
  const shapes = ["cubby", "tri", "penny", "hex", "stella", "orbi", "gem", "bloom"]
  assert.equal(new Set(shapes.map(botIdOf)).size, shapes.length)
})

test("a retired id draws the character that replaced it", async () => {
  await mount(<Bot id="hex" />, async () => {
    assert.equal(src(), "/bots/byte/happy.png")
  })
  await mount(<Bot id="nonsense" />, async () => {
    assert.ok(src()?.endsWith("/happy.png"), "an unknown id draws the first character")
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

/** The pose on show: the image in the slot the swap's state names. */
const poseOf = (root: HTMLElement) => {
  const front = root.querySelector(".t-icon-swap")?.getAttribute("data-state")
  return root.querySelector(`.t-icon[data-icon="${front}"] img`)?.getAttribute("src")
}
const box = (root: HTMLElement) => root.querySelector<HTMLElement>(".t-like")!

test("an animated posed bot draws the pose its mood names, and poofs to the next", async () => {
  await withCrumb(async (draw, root) => {
    await draw("wave")
    assert.equal(poseOf(root), "/bots/crumb/wave.png")
    assert.equal(box(root).dataset.liked, "false", "nothing has popped yet")
    await draw("love")
    await until(async () => poseOf(root) === "/bots/crumb/love.png", "the pose to change")
    const slots = [...root.querySelectorAll(".t-icon img")].map((img) => img.getAttribute("src"))
    assert.deepEqual(
      slots.sort(),
      ["/bots/crumb/love.png", "/bots/crumb/wave.png"],
      "the old pose fades out under the new one",
    )
    assert.equal(box(root).dataset.liked, "true", "the body pops")
    assert.ok(box(root).classList.contains("is-bursting"), "a puff of smoke is thrown")
    const puffs = [...root.querySelectorAll<HTMLElement>(".t-like-particles i")]
    assert.equal(puffs.length, 8)
    assert.ok(
      puffs.every((puff) => puff.style.getPropertyValue("--px") !== ""),
      "each puff has its own vector",
    )
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
      await draw("curious")
      await until(async () => poseOf(root) === "/bots/crumb/curious.png", "the pose to change")
      assert.equal(box(root).dataset.liked, "false", "no pop")
      assert.ok(!box(root).classList.contains("is-bursting"), "no smoke")
    })
  })
})

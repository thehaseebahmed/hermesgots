/**
 * The `+` menu's Files entry is offered where the bot's host advertises the plugin's `attachments`
 * feature, and refused there, with the reason, where it doesn't — so a host whose plugin predates
 * the upload route refuses at the menu instead of failing at send. The answer follows the plugin
 * features rule (`src/lib/features.ts`): a real answer is remembered for its connection, and a host
 * that was away is asked again rather than read as a no. The host is faked at the HTTP boundary and
 * the menu is read off the screen, never out of its internals.
 */
import assert from "node:assert/strict"
import test from "node:test"

import {
  botProfile,
  chatScreen,
  click,
  findAll,
  json,
  mount,
  seedChat,
  text,
  until,
} from "./component-kit.tsx"

const CHAT = "chat-attachments"

/** A host that answers its plugin's `info` with `features`, or doesn't answer at all ("away"). */
function host(features: string[] | "away", name: string, asked: string[]) {
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = new URL(String(input instanceof Request ? input.url : input))
    if (!url.host.startsWith(name)) return json({})
    asked.push(url.pathname)
    if (url.pathname.endsWith("/plugins/memento/info"))
      return features === "away"
        ? json({ error: { message: "The host is away." } }, 503)
        : json({ name: "memento", version: "0.79.0", features })
    return json({})
  }) as typeof fetch
  return asked
}

const infoReads = (asked: string[]) => asked.filter((path) => path.endsWith("/info")).length

const seed = (name: string) => seedChat({ id: CHAT, profile: botProfile(name, { id: "bot-1" }) })

const addContext = () => document.querySelector('[aria-label="Add context"]')
const source = (label: string) =>
  findAll("button").find((button) => button.textContent?.trim() === label) ?? null

async function openMenu() {
  await until(async () => Boolean(addContext()), "the + button")
  await click(addContext())
  await until(async () => Boolean(source("Files")), "the menu's sources")
}

test("a host that advertises no attachments refuses Files at the menu, with its reason", async () => {
  await seed("attach-menu-old")
  host(["media"], "attach-menu-old", [])
  await mount(chatScreen(CHAT), async () => {
    await openMenu()
    assert.equal(source("Files")?.hasAttribute("disabled"), true, "Files is refused")
    assert.match(text(), /File uploads need a newer Gots plugin\./, "and says what is missing")
    assert.equal(source("Camera")?.hasAttribute("disabled"), false, "Camera is untouched")
  })
})

test("a host that advertises attachments offers Files as it always has", async () => {
  await seed("attach-menu-new")
  host(["attachments", "media"], "attach-menu-new", [])
  await mount(chatScreen(CHAT), async () => {
    await openMenu()
    assert.equal(source("Files")?.hasAttribute("disabled"), false, "Files is offered")
    assert.doesNotMatch(text(), /File uploads need/, "and there is nothing to explain")
  })
})

test("a host that was away is asked again, not remembered as a no", async () => {
  await seed("attach-menu-away")
  const asked: string[] = []
  host("away", "attach-menu-away", asked)
  await mount(chatScreen(CHAT), async () => {
    await openMenu()
    assert.equal(
      source("Files")?.hasAttribute("disabled"),
      true,
      "no answer, so nothing is offered",
    )
    assert.match(text(), /File uploads need the Gots plugin\./, "and the menu says what it needs")
  })
  const askedWhileAway = infoReads(asked)
  assert.ok(askedWhileAway > 0, "the host was asked")
  host(["attachments"], "attach-menu-away", asked)
  await mount(chatScreen(CHAT), async () => {
    await until(async () => infoReads(asked) > askedWhileAway, "a second ask")
    await openMenu()
    assert.equal(source("Files")?.hasAttribute("disabled"), false, "the real answer fills it")
  })
})

test("the gallery picker offers clips as well as photos, and the camera stays a still", async () => {
  await seed("attach-menu-clips")
  host(["attachments", "media"], "attach-menu-clips", [])
  await mount(chatScreen(CHAT), async () => {
    await openMenu()
    const photos = document.querySelector('input[name="photos"]')
    assert.ok(photos, "the gallery's own picker")
    assert.match(photos.getAttribute("accept") ?? "", /image\/\*/, "photos")
    assert.match(photos.getAttribute("accept") ?? "", /video\/\*/, "and clips")
    assert.equal(photos.hasAttribute("multiple"), true, "as many as the message can hold")
    const camera = document.querySelector('input[name="camera"]')
    assert.equal(camera?.getAttribute("accept"), "image/*", "the camera takes a still, not a clip")
    assert.equal(camera?.hasAttribute("capture"), true)
  })
})

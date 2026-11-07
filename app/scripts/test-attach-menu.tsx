/**
 * The `+` menu offers each source by the road what it picks can take. Files is offered where the
 * bot's host advertises the plugin's `attachments` feature and refused there, with the reason,
 * where it doesn't — so a host whose plugin predates the upload route refuses at the menu instead
 * of failing at send. Camera and Photos pick pictures, so they follow a picture's road: offered
 * wherever the model reads images (the inline road) or the host may still take a file, refused only
 * where the host answered that it has no route and the model reads no images — the one state where
 * a photo reaches the agent by no road at all, said out loud in the same sentence. The answer
 * follows the plugin features rule (`src/lib/features.ts`): a real answer is remembered for its
 * connection, and a host that was away is asked again rather than read as a no. The host is faked at
 * the HTTP boundary and the menu is read off the screen, never out of its internals.
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
    if (url.pathname.endsWith("/plugins/gots/info"))
      return features === "away"
        ? json({ error: { message: "The host is away." } }, 503)
        : json({ name: "gots", version: "0.79.0", features })
    return json({})
  }) as typeof fetch
  return asked
}

const infoReads = (asked: string[]) => asked.filter((path) => path.endsWith("/info")).length

const seed = (name: string, patch: Parameters<typeof botProfile>[1] = {}) =>
  seedChat({ id: CHAT, profile: botProfile(name, { id: "bot-1", ...patch }) })

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
    assert.equal(
      source("Camera")?.hasAttribute("disabled"),
      false,
      "a picture the model reads rides inline, so the camera is still offered",
    )
    assert.equal(source("Photos")?.hasAttribute("disabled"), false, "and the gallery with it")
  })
})

test("a model that takes no pictures still offers Camera and Photos", async () => {
  await seed("attach-menu-no-images", { imageInput: false })
  host(["attachments", "media"], "attach-menu-no-images", [])
  await mount(chatScreen(CHAT), async () => {
    await openMenu()
    assert.equal(
      source("Camera")?.hasAttribute("disabled"),
      false,
      "a picture travels as a file where the model can't read it",
    )
    assert.equal(source("Photos")?.hasAttribute("disabled"), false, "and the gallery with it")
    assert.equal(source("Files")?.hasAttribute("disabled"), false, "Files keeps its own road")
    assert.doesNotMatch(
      text(),
      /File uploads need/,
      "and nothing is refused, so nothing is explained",
    )
  })
})

test("a host with no upload route refuses all three, with its reason", async () => {
  await seed("attach-menu-none", { imageInput: false })
  // An answer owed is not a no: with the model reading no images, a photo is still tried on the
  // host's route, and only Files — which needs that route confirmed — is refused.
  host("away", "attach-menu-none", [])
  await mount(chatScreen(CHAT), async () => {
    await openMenu()
    assert.equal(
      source("Camera")?.hasAttribute("disabled"),
      false,
      "a route not answered yet refuses no photo",
    )
    assert.equal(source("Photos")?.hasAttribute("disabled"), false, "nor the gallery")
    assert.equal(source("Files")?.hasAttribute("disabled"), true, "while Files waits on the answer")
  })
  // Once the host answers that it has none, no photo can reach the agent either, and the sheet
  // says why in the one sentence above them.
  host(["media"], "attach-menu-none", [])
  await mount(chatScreen(CHAT), async () => {
    await openMenu()
    for (const label of ["Camera", "Photos", "Files"])
      assert.equal(source(label)?.hasAttribute("disabled"), true, `${label} is refused`)
    assert.match(
      text(),
      /File uploads need a newer Gots plugin\./,
      "in the one sentence above them",
    )
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

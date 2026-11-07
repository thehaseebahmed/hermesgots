import assert from "node:assert/strict"
import test from "node:test"
import { toast } from "sonner"

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

/** `disabled` would eat the tap, so a source nothing can carry is marked unavailable and stays live. */
const shut = (label: string) => source(label)?.getAttribute("aria-disabled") === "true"

/** Taps a source and answers what it said: the refusal is a toast, and the sheet is left open. */
async function tapped(label: string) {
  const said: string[] = []
  const original = toast.error
  toast.error = ((message: unknown) => {
    said.push(String(message))
  }) as typeof toast.error
  try {
    await click(source(label))
  } finally {
    toast.error = original
  }
  return said
}

async function openMenu() {
  await until(async () => Boolean(addContext()), "the + button")
  await click(addContext())
  await until(async () => Boolean(source("Files")), "the menu's sources")
}

test("a host that advertises no attachments refuses Files, and says why when it is tapped", async () => {
  await seed("attach-menu-old")
  host(["media"], "attach-menu-old", [])
  await mount(chatScreen(CHAT), async () => {
    await openMenu()
    assert.equal(source("Files")?.hasAttribute("disabled"), false, "Files stays tappable")
    assert.equal(shut("Files"), true, "and reads as unavailable")
    assert.equal(
      shut("Camera"),
      false,
      "a picture the model reads rides inline, so the camera is still offered",
    )
    assert.equal(shut("Photos"), false, "and the gallery with it")
    assert.doesNotMatch(text(), /File uploads need/, "nothing is explained before it is asked")
    assert.deepEqual(
      await tapped("Files"),
      ["File uploads need a newer Gots plugin."],
      "a tap says why, in the rule's own sentence",
    )
    assert.ok(source("Files"), "and the sheet is still open")
  })
})

test("a model that takes no pictures still offers Camera and Photos", async () => {
  await seed("attach-menu-no-images", { imageInput: false })
  host(["attachments", "media"], "attach-menu-no-images", [])
  await mount(chatScreen(CHAT), async () => {
    await openMenu()
    assert.equal(shut("Camera"), false, "a picture travels as a file where the model can't read it")
    assert.equal(shut("Photos"), false, "and the gallery with it")
    assert.equal(shut("Files"), false, "Files keeps its own road")
    assert.doesNotMatch(
      text(),
      /File uploads need/,
      "and nothing is refused, so nothing is explained",
    )
  })
})

test("a host with no upload route refuses all three, and each says why when it is tapped", async () => {
  await seed("attach-menu-none", { imageInput: false })
  host("away", "attach-menu-none", [])
  await mount(chatScreen(CHAT), async () => {
    await openMenu()
    assert.equal(shut("Camera"), false, "a route not answered yet refuses no photo")
    assert.equal(shut("Photos"), false, "nor the gallery")
    assert.equal(shut("Files"), true, "while Files waits on the answer")
  })
  host(["media"], "attach-menu-none", [])
  await mount(chatScreen(CHAT), async () => {
    await openMenu()
    for (const label of ["Camera", "Photos", "Files"]) {
      assert.equal(source(label)?.hasAttribute("disabled"), false, `${label} stays tappable`)
      assert.equal(shut(label), true, `${label} is refused`)
    }
    for (const label of ["Camera", "Photos", "Files"])
      assert.deepEqual(
        await tapped(label),
        ["File uploads need a newer Gots plugin."],
        `${label} says why it can't, in the rule's own sentence`,
      )
    assert.ok(source("Camera"), "and the sheet stays open")
    assert.doesNotMatch(text(), /File uploads need/, "nothing is explained on the sheet itself")
  })
})

test("a host that advertises attachments offers Files as it always has", async () => {
  await seed("attach-menu-new")
  host(["attachments", "media"], "attach-menu-new", [])
  await mount(chatScreen(CHAT), async () => {
    await openMenu()
    assert.equal(shut("Files"), false, "Files is offered")
    assert.doesNotMatch(text(), /File uploads need/, "and there is nothing to explain")
  })
})

test("a host that hasn't answered offers Camera and Photos, and Files says why it waits", async () => {
  await seed("attach-menu-owed", { imageInput: false })
  host("away", "attach-menu-owed", [])
  await mount(chatScreen(CHAT), async () => {
    await openMenu()
    assert.equal(shut("Camera"), false, "the camera is offered")
    assert.equal(shut("Photos"), false, "and the gallery with it")
    assert.equal(shut("Files"), true, "while Files waits on the answer")
    assert.deepEqual(
      await tapped("Files"),
      ["File uploads need the Gots plugin."],
      "and a tap says why it waits",
    )
  })
})

test("a host that was away is asked again, not remembered as a no", async () => {
  await seed("attach-menu-away")
  const asked: string[] = []
  host("away", "attach-menu-away", asked)
  await mount(chatScreen(CHAT), async () => {
    await openMenu()
    assert.equal(shut("Files"), true, "no answer, so nothing is offered")
    assert.equal(shut("Camera"), false, "a photo is still tried")
  })
  const askedWhileAway = infoReads(asked)
  assert.ok(askedWhileAway > 0, "the host was asked")
  host(["attachments"], "attach-menu-away", asked)
  await mount(chatScreen(CHAT), async () => {
    await until(async () => infoReads(asked) > askedWhileAway, "a second ask")
    await openMenu()
    assert.equal(shut("Files"), false, "the real answer fills it")
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

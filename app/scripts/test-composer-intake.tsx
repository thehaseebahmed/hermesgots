/**
 * The composer's own intake surfaces: a paste and a drop both add what arrived, under the caps a
 * pick is held to, and neither sends. The caps' words themselves are the pure rule's
 * (`test-attachment-caps.mjs`); what this holds is the wiring a DOM alone can fail.
 */
import assert from "node:assert/strict"
import test from "node:test"
import { act } from "react"
import { toast } from "sonner"

import { Composer } from "@/components/chat/composer"
import { MAX_FILE_BYTES } from "@/lib/attachment-caps"
import { wireContent } from "@/lib/attachments"
import type { Attachment } from "@/lib/db"
import type { PluginFeatureAnswer } from "@/lib/features"
import { uploadAttachments } from "@/lib/send-turn"

import { PreviewerProvider } from "@/components/chat/previewer"

import { click, connection, findAll, json, mount, settle, until } from "./component-kit.tsx"

const bot = connection("composer-intake")

/** A host that saves a file on the route it is posted to and answers where it put it. */
function host(name: string) {
  const saved: { name: string; type: string }[] = []
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input instanceof Request ? input.url : input))
    if (!url.host.startsWith(name)) return json({})
    if (url.pathname.endsWith("/attachments") && init?.method === "POST") {
      const file = url.searchParams.get("name") ?? ""
      saved.push({ name: file, type: (init.body as Blob).type })
      return json({ name: file, path: `/host/${file}`, size: (init.body as Blob).size })
    }
    return json({})
  }) as typeof fetch
  return saved
}

function composer(
  sent: { text: string; attachments: Attachment[] }[],
  filesFeature: PluginFeatureAnswer = "yes",
  imagesAvailable = true,
  send?: (text: string, attachments: Attachment[]) => Promise<void> | void,
) {
  return (
    <Composer
      busy={false}
      onSend={send ?? ((text, attachments) => {
        sent.push({ text, attachments })
      })}
      onQueue={() => {}}
      onStop={() => {}}
      onCommand={() => {}}
      connection={bot}
      filesFeature={filesFeature}
      imagesAvailable={imagesAvailable}
    />
  )
}

const tileNames = () =>
  findAll("[aria-label^='Remove ']").map((button) =>
    button.getAttribute("aria-label")!.replace("Remove ", ""),
  )

async function paste(files: File[]) {
  const field = document.querySelector("textarea")
  assert.ok(field, "the composer's field is on screen")
  const event = new Event("paste", { bubbles: true, cancelable: true })
  Object.defineProperty(event, "clipboardData", {
    value: { files, items: files.map((file) => ({ kind: "file", getAsFile: () => file })) },
  })
  await act(async () => {
    field.dispatchEvent(event)
  })
  await settle()
}

async function drop(files: File[]) {
  const form = document.querySelector("form")
  assert.ok(form, "the composer is on screen")
  const event = new Event("drop", { bubbles: true, cancelable: true })
  Object.defineProperty(event, "dataTransfer", { value: { files, types: ["Files"] } })
  await act(async () => {
    form.dispatchEvent(event)
  })
  await settle()
}

/** A pick from the `+` menu's own file input, the way the browser hands one over. */
async function pick(source: "camera" | "photos" | "files", files: File[]) {
  const input = document.querySelector(`input[name="${source}"]`)
  assert.ok(input, "the menu's picker is on screen")
  Object.defineProperty(input, "files", { value: files, configurable: true })
  await act(async () => {
    input.dispatchEvent(new Event("change", { bubbles: true }))
  })
  await settle()
}

const note = (name: string, body = "hello") =>
  new File([body], name, { type: "text/plain", lastModified: 1_700_000_000_000 })

async function removeAttachment(name: string) {
  const button = findAll("button").find(
    (one) => one.getAttribute("aria-label") === `Remove ${name}`,
  )
  assert.ok(button, `the ${name} tile's remove button`)
  await act(async () => {
    button.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }))
  })
  await settle()
}

test("a file picked again after its tile is removed lands a second time", async () => {
  const sent: { text: string; attachments: Attachment[] }[] = []
  await mount(composer(sent), async () => {
    const file = note("again.txt")
    await pick("files", [file])
    assert.deepEqual(tileNames(), ["again.txt"], "the pick lands")
    await removeAttachment("again.txt")
    assert.deepEqual(tileNames(), [], "the user took it off")
    await pick("files", [file])
    assert.deepEqual(tileNames(), ["again.txt"], "picking the very same file lands again")
  })
})

test("a pasted file lands on the message and sends nothing", async () => {
  const sent: { text: string; attachments: Attachment[] }[] = []
  await mount(composer(sent), async () => {
    await paste([note("notes.txt")])
    assert.deepEqual(tileNames(), ["notes.txt"], "the file is on the message, ready to send")
    assert.deepEqual(sent, [], "pasting never sends on its own")
  })
})

test("a pasted photo lands the same way", async () => {
  const sent: { text: string; attachments: Attachment[] }[] = []
  await mount(composer(sent), async () => {
    await paste([new File(["png"], "cat.png", { type: "image/png", lastModified: 2 })])
    assert.deepEqual(tileNames(), ["cat.png"])
    assert.deepEqual(sent, [])
  })
})

test("a file dropped onto the composer lands on the message", async () => {
  const sent: { text: string; attachments: Attachment[] }[] = []
  await mount(composer(sent), async () => {
    await drop([note("clip.txt")])
    assert.deepEqual(tileNames(), ["clip.txt"])
    assert.deepEqual(sent, [], "dropping never sends on its own")
  })
})

test("the same file pasted and then dropped lands once", async () => {
  const sent: { text: string; attachments: Attachment[] }[] = []
  await mount(composer(sent), async () => {
    const file = note("once.txt")
    await paste([file])
    await drop([file])
    assert.deepEqual(tileNames(), ["once.txt"], "one file, one attachment")
  })
})

test("a pasted file is refused where the menu's Files is off, in the menu's own words", async () => {
  const said: string[] = []
  const original = toast.error
  const sent: { text: string; attachments: Attachment[] }[] = []
  toast.error = ((message: unknown) => {
    said.push(String(message))
  }) as typeof toast.error
  try {
    await mount(composer(sent, "no"), async () => {
      await paste([note("notes.txt")])
      assert.deepEqual(said, ["File uploads need a newer Gots plugin."], "the menu's own reason")
      assert.deepEqual(tileNames(), [], "the file never lands")
      // A photo the model reads inline needs no upload route, so Photos stays allowed.
      await paste([new File(["png"], "cat.png", { type: "image/png", lastModified: 3 })])
      assert.deepEqual(tileNames(), ["cat.png"], "a photo still lands")
    })
  } finally {
    toast.error = original
  }
})

test("a pasted photo is refused where the host has no upload route, in the same words", async () => {
  const said: string[] = []
  const original = toast.error
  const sent: { text: string; attachments: Attachment[] }[] = []
  toast.error = ((message: unknown) => {
    said.push(String(message))
  }) as typeof toast.error
  try {
    await mount(composer(sent, "no", false), async () => {
      await paste([new File(["png"], "cat.png", { type: "image/png", lastModified: 6 })])
      assert.deepEqual(said, ["File uploads need a newer Gots plugin."], "the route's own reason")
      assert.deepEqual(tileNames(), [], "a picture nothing can carry never lands")
      assert.deepEqual(sent, [])
    })
  } finally {
    toast.error = original
  }
})

test("a file dropped where no plugin answered is refused the same way", async () => {
  const said: string[] = []
  const original = toast.error
  const sent: { text: string; attachments: Attachment[] }[] = []
  toast.error = ((message: unknown) => {
    said.push(String(message))
  }) as typeof toast.error
  try {
    await mount(composer(sent, "unknown"), async () => {
      await drop([note("clip.txt")])
      assert.deepEqual(said, ["File uploads need the Gots plugin."])
      assert.deepEqual(tileNames(), [], "a drop is held to the pick's rule")
      assert.deepEqual(sent, [])
    })
  } finally {
    toast.error = original
  }
})

test("a file over nine megabytes is refused by name instead of landing", async () => {
  const said: string[] = []
  const original = toast.error
  const sent: { text: string; attachments: Attachment[] }[] = []
  toast.error = ((message: unknown) => {
    said.push(String(message))
  }) as typeof toast.error
  try {
    await mount(composer(sent), async () => {
      await paste([new File([new Uint8Array(MAX_FILE_BYTES + 1)], "big.bin")])
      assert.deepEqual(said, ["big.bin is over the 9 MB limit."])
      assert.deepEqual(tileNames(), [], "it never lands")
      assert.deepEqual(sent, [])
    })
  } finally {
    toast.error = original
  }
})

test("a clip picked from the gallery lands, and one over nine megabytes is refused there", async () => {
  const said: string[] = []
  const original = toast.error
  const sent: { text: string; attachments: Attachment[] }[] = []
  toast.error = ((message: unknown) => {
    said.push(String(message))
  }) as typeof toast.error
  const clip = (name: string, bytes = 4) =>
    new File([new Uint8Array(bytes)], name, {
      type: "video/mp4",
      lastModified: 1_700_000_000_000,
    })
  try {
    await mount(composer(sent), async () => {
      await pick("photos", [clip("clip.mp4")])
      assert.deepEqual(tileNames(), ["clip.mp4"], "the clip is on the message, ready to send")
      await pick("photos", [clip("long-take.mp4", MAX_FILE_BYTES + 1)])
      assert.deepEqual(said, ["long-take.mp4 is over the 9 MB limit."], "refused at the pick")
      assert.deepEqual(tileNames(), ["clip.mp4"], "and it never lands")
      assert.deepEqual(sent, [], "nothing is sent by a pick")
    })
  } finally {
    toast.error = original
  }
})

test("a photo picked for a model that takes no pictures lands as a file, and its send names the path", async () => {
  const saved = host("composer-intake")
  const sent: { text: string; attachments: Attachment[] }[] = []
  const send = async (text: string, attachments: Attachment[]) => {
    sent.push({ text, attachments: await uploadAttachments(bot, "session-1", attachments, true) })
  }
  await mount(composer(sent, "yes", false, send), async () => {
    await pick("camera", [
      new File(["heic"], "IMG_0001.heic", { type: "image/heic", lastModified: 7 }),
    ])
    assert.deepEqual(tileNames(), ["IMG_0001.heic"], "the pick lands, on the host's file road")
    await click(findAll("button").find((one) => one.getAttribute("aria-label") === "Send"))
    await until(async () => sent.length > 0, "the send")

    assert.deepEqual(
      saved,
      [{ name: "IMG_0001.heic", type: "image/heic" }],
      "the host is handed the photo itself",
    )
    const [photo] = sent[0].attachments
    assert.equal(photo.image, true, "it is still the picture it is")
    assert.equal(photo.inline, undefined, "and no bytes of it ride in the message")
    assert.equal(photo.path, "/host/IMG_0001.heic", "the path the host answered with")

    const parts = await wireContent(sent[0].text, sent[0].attachments)
    const said =
      typeof parts === "string"
        ? parts
        : parts
            .map((part) => (part.type === "text" ? part.text : `[${part.type}]`))
            .join("\n")
    assert.match(said, /path="\/host\/IMG_0001\.heic"/, "the message names the copy the agent opens")
    assert.doesNotMatch(said, /\[screenshot\]/, "and no photo is promised inline")
    assert.match(
      said,
      /is not included in this message/,
      "the message says the bytes stayed on the host",
    )
  })
})

test("a photo over nine megabytes is scaled to fit on the file road", async () => {
  const saved = host("composer-intake")
  const sent: { text: string; attachments: Attachment[] }[] = []
  const send = async (text: string, attachments: Attachment[]) => {
    sent.push({ text, attachments: await uploadAttachments(bot, "session-1", attachments, true) })
  }
  // jsdom decodes no image, draws none and makes no object URL: the browser's own effect stands in.
  const proto = Object.getPrototypeOf(document.createElement("canvas")) as HTMLCanvasElement
  const real = {
    bitmap: globalThis.createImageBitmap,
    context: proto.getContext,
    toBlob: proto.toBlob,
    create: URL.createObjectURL,
    revoke: URL.revokeObjectURL,
  }
  globalThis.createImageBitmap = (async () => ({
    width: 4000,
    height: 3000,
    close: () => {},
  })) as unknown as typeof createImageBitmap
  proto.getContext = (() => ({ drawImage() {} })) as typeof proto.getContext
  proto.toBlob = ((done: BlobCallback) =>
    done(new Blob(["jpeg"], { type: "image/jpeg" }))) as typeof proto.toBlob
  URL.createObjectURL = (blob: Blob | MediaSource) => `blob:${(blob as Blob).type}`
  URL.revokeObjectURL = () => {}
  const refusals: string[] = []
  const original = toast.error
  toast.error = ((message: unknown) => {
    refusals.push(String(message))
  }) as typeof toast.error
  try {
    await mount(composer(sent, "yes", false, send), async () => {
      await pick("camera", [
        new File([new Uint8Array(MAX_FILE_BYTES + 1)], "IMG_0001.heic", {
          type: "image/heic",
          lastModified: 9,
        }),
      ])
      assert.deepEqual(refusals, [], "nothing is refused over its size")
      await until(async () => tileNames().length === 1, "the photo's tile")
      assert.deepEqual(tileNames(), ["IMG_0001.jpg"], "the scaled JPEG is what is on the message")

      await click(findAll("button").find((one) => one.getAttribute("aria-label") === "Send"))
      await until(async () => sent.length > 0, "the send")

      assert.deepEqual(
        saved,
        [{ name: "IMG_0001.jpg", type: "image/jpeg" }],
        "the host is handed the JPEG, not the photo it could not take",
      )
      const [photo] = sent[0].attachments
      assert.equal(photo.image, true, "it is still the picture it is")
      assert.equal(photo.inline, undefined, "and no bytes of it ride in the message")
      assert.equal(photo.type, "image/jpeg", "the copy is typed as what it is")
      assert.ok(photo.size < MAX_FILE_BYTES, "the copy is the scaled one, so it fits the cap")
      assert.equal(photo.name, "IMG_0001.jpg", "named after the photo the user picked")

      const parts = await wireContent(sent[0].text, sent[0].attachments)
      const said =
        typeof parts === "string"
          ? parts
          : parts
              .map((part) => (part.type === "text" ? part.text : `[${part.type}]`))
              .join("\n")
      assert.match(said, /path="\/host\/IMG_0001\.jpg"/, "the message names the copy the agent opens")
      assert.doesNotMatch(said, /\[screenshot\]/, "and no photo is promised inline")
    })
  } finally {
    toast.error = original
    if (real.bitmap) globalThis.createImageBitmap = real.bitmap
    else delete (globalThis as { createImageBitmap?: typeof createImageBitmap }).createImageBitmap
    proto.getContext = real.context
    proto.toBlob = real.toBlob
    URL.createObjectURL = real.create
    URL.revokeObjectURL = real.revoke
  }
})

test("a photo over nine megabytes the browser can't decode is still refused by its size", async () => {
  const refusals: string[] = []
  const original = toast.error
  toast.error = ((message: unknown) => {
    refusals.push(String(message))
  }) as typeof toast.error
  try {
    await mount(composer([], "yes", false), async () => {
      await pick("camera", [
        new File([new Uint8Array(MAX_FILE_BYTES + 1)], "IMG_0003.heic", {
          type: "image/heic",
          lastModified: 12,
        }),
      ])
      assert.deepEqual(refusals, ["IMG_0003.heic is over the 9 MB limit."])
      assert.deepEqual(tileNames(), [], "and it never lands")
    })
  } finally {
    toast.error = original
  }
})

test("a photo the browser can't decode is still the picture it is, and carries no part", async () => {
  const saved = host("composer-intake")
  const sent: { text: string; attachments: Attachment[] }[] = []
  const send = async (text: string, attachments: Attachment[]) => {
    sent.push({ text, attachments: await uploadAttachments(bot, "session-1", attachments, true) })
  }
  await mount(composer(sent, "yes", true, send), async () => {
    await pick("photos", [
      new File(["heic"], "IMG_0004.heic", { type: "image/heic", lastModified: 13 }),
    ])
    assert.deepEqual(tileNames(), ["IMG_0004.heic"], "the pick lands")
    await click(findAll("button").find((one) => one.getAttribute("aria-label") === "Send"))
    await until(async () => sent.length > 0, "the send")

    assert.deepEqual(saved, [{ name: "IMG_0004.heic", type: "image/heic" }], "the host keeps it")
    const [photo] = sent[0].attachments
    assert.equal(photo.image, true, "it is the picture it is, on either road")
    assert.equal(photo.inline, undefined, "and no undecodable bytes ride in the message")

    const parts = await wireContent(sent[0].text, sent[0].attachments)
    const said =
      typeof parts === "string"
        ? parts
        : parts.map((part) => (part.type === "text" ? part.text : `[${part.type}]`)).join("\n")
    assert.doesNotMatch(said, /\[screenshot\]/, "no image part is promised")
    assert.match(said, /is not included in this message/, "and the message says where it is")
  })
})

test("a photo picked before the host answered is tried, not refused", async () => {
  const said: string[] = []
  const original = toast.error
  const sent: { text: string; attachments: Attachment[] }[] = []
  toast.error = ((message: unknown) => {
    said.push(String(message))
  }) as typeof toast.error
  try {
    await mount(composer(sent, "unknown", false), async () => {
      await pick("photos", [
        new File(["heic"], "IMG_0002.heic", { type: "image/heic", lastModified: 11 }),
      ])
      assert.deepEqual(tileNames(), ["IMG_0002.heic"], "the pick is tried on the host's file road")
      assert.deepEqual(said, [], "and nothing is refused over an answer still owed")
      assert.deepEqual(sent, [], "a pick never sends on its own")
    })
  } finally {
    toast.error = original
  }
})

test("a staged photo and clip open the screen's Previewer, and Remove takes one off the message", async () => {
  const sent: { text: string; attachments: Attachment[] }[] = []
  const real = { create: URL.createObjectURL, revoke: URL.revokeObjectURL }
  URL.createObjectURL = (blob: Blob | MediaSource) => `blob:${(blob as Blob).type || "bytes"}`
  URL.revokeObjectURL = () => {}
  try {
    await mount(<PreviewerProvider>{composer(sent)}</PreviewerProvider>, async () => {
      await paste([
        new File(["png"], "cat.png", { type: "image/png", lastModified: 4 }),
        new File(["webm"], "take.webm", { type: "video/webm", lastModified: 4 }),
      ])
      assert.deepEqual(tileNames(), ["cat.png", "take.webm"], "both are on the message")

      await click(
        findAll("button").find((one) => one.getAttribute("aria-label") === "Open cat.png"),
      )
      await until(async () => document.querySelector('img[alt="cat.png"]') !== null, "the photo")
      assert.equal(
        findAll("button").some((one) => one.textContent === "Remove"),
        true,
        "Remove is the composer's",
      )

      await click(findAll("button").find((one) => one.getAttribute("aria-label") === "Next"))
      await until(async () => document.querySelector("video") !== null, "the clip's player")
      assert.equal(document.querySelector("video")!.hasAttribute("autoplay"), false)

      await click(findAll("button").find((one) => one.textContent === "Remove"))
      await settle()
      assert.deepEqual(tileNames(), ["cat.png"], "the clip left the message")
      assert.deepEqual(sent, [], "nothing was sent")
    })
  } finally {
    URL.createObjectURL = real.create
    URL.revokeObjectURL = real.revoke
  }
})

test("a staged photo this device can't draw is handed to the platform, not the Previewer", async () => {
  const sent: { text: string; attachments: Attachment[] }[] = []
  const real = {
    create: URL.createObjectURL,
    revoke: URL.revokeObjectURL,
    open: window.open,
  }
  const opened: string[] = []
  URL.createObjectURL = (blob: Blob | MediaSource) => `blob:${(blob as Blob).type || "bytes"}`
  URL.revokeObjectURL = () => {}
  window.open = ((url: string | URL) => {
    opened.push(String(url))
    return null
  }) as typeof window.open
  try {
    await mount(<PreviewerProvider>{composer(sent)}</PreviewerProvider>, async () => {
      await pick("photos", [
        new File(["heic"], "IMG_0005.heic", { type: "image/heic", lastModified: 14 }),
      ])
      await click(
        findAll("button").find((one) => one.getAttribute("aria-label") === "Open IMG_0005.heic"),
      )
      await until(async () => opened.length > 0, "the platform's hand-off")
      assert.match(opened[0], /^blob:/, "the bytes this device holds, under its own name")
      assert.equal(document.querySelector('[role="dialog"]'), null, "and no Previewer opens")
    })
  } finally {
    URL.createObjectURL = real.create
    URL.revokeObjectURL = real.revoke
    window.open = real.open
  }
})

test("a staged file this device holds is handed to the platform from its own bytes", async () => {
  const sent: { text: string; attachments: Attachment[] }[] = []
  const real = { create: URL.createObjectURL, revoke: URL.revokeObjectURL, open: window.open }
  const opened: string[] = []
  URL.createObjectURL = (blob: Blob | MediaSource) => `blob:${(blob as Blob).type || "bytes"}`
  URL.revokeObjectURL = () => {}
  window.open = ((url: string | URL) => {
    opened.push(String(url))
    return null
  }) as typeof window.open
  try {
    await mount(<PreviewerProvider>{composer(sent)}</PreviewerProvider>, async () => {
      await drop([new File(["PK"], "logs.zip", { type: "application/zip", lastModified: 5 })])
      await click(
        findAll("button").find((one) => one.getAttribute("aria-label") === "Open logs.zip"),
      )
      await until(async () => opened.length > 0, "the tab")
      assert.match(opened[0], /^blob:/, "the bytes this device holds, which the host never saw")
      assert.equal(document.querySelector('[role="dialog"]'), null, "a file is never previewed")
    })
  } finally {
    URL.createObjectURL = real.create
    URL.revokeObjectURL = real.revoke
    window.open = real.open
  }
})

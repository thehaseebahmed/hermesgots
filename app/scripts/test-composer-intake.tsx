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
import type { Attachment } from "@/lib/db"

import { connection, findAll, mount, settle } from "./component-kit.tsx"

const bot = connection("composer-intake")

function composer(
  sent: { text: string; attachments: Attachment[] }[],
  filesFeature: "unknown" | "yes" | "no" = "yes",
) {
  return (
    <Composer
      busy={false}
      onSend={(text, attachments) => {
        sent.push({ text, attachments })
      }}
      onQueue={() => {}}
      onStop={() => {}}
      onCommand={() => {}}
      connection={bot}
      filesFeature={filesFeature}
      imagesAvailable
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
  const button = findAll("button").find((one) => one.getAttribute("aria-label") === `Remove ${name}`)
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

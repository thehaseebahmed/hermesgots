import assert from "node:assert/strict"
import test from "node:test"

import { Composer } from "@/components/chat/composer"
import { SEND_WAIT_MS } from "@/lib/dictation"
import { db, type Attachment } from "@/lib/db"
import {
  click,
  connection,
  findAll,
  mount,
  seedSettings,
  settle,
  text,
  type,
  until,
} from "./component-kit.tsx"
import {
  FakeRecorder,
  dictationHost,
  installFakeMedia,
  type DictationHostOptions,
} from "./fake-dictation.ts"

installFakeMedia()

const bot = connection("dictation-ending")
const HEARD = "um Let us ship the dictation"
const TIDIED = "Let us ship the dictation."
const VOCABULARY = ["Gots"]

function host(options: DictationHostOptions = {}) {
  return dictationHost({ heard: HEARD, tidied: TIDIED, ...options })
}

const composer = (draftKey: string, sent: { text: string; attachments: Attachment[] }[]) => (
  <Composer
    busy={false}
    onSend={(words, attachments) => {
      sent.push({ text: words, attachments })
    }}
    onQueue={() => {}}
    onStop={() => {}}
    onCommand={() => {}}
    connection={bot}
    filesAvailable={false}
    imagesAvailable
    draftKey={draftKey}
    dictationWords={VOCABULARY}
  />
)

const field = (scope: ParentNode = document) =>
  scope.querySelector("textarea") as HTMLTextAreaElement | null
const bar = (scope: ParentNode = document) =>
  scope.querySelector('[role="group"][aria-label="Dictation take"]')
const region = (scope: ParentNode = document) =>
  scope.querySelector('[role="region"][aria-label="Dictation"]')
const button = (label: string, scope: ParentNode = document) =>
  scope.querySelector(`[aria-label="${label}"]`)
const alert = (scope: ParentNode = document) => scope.querySelector('[role="alert"]')

async function openTake(scope: ParentNode = document) {
  await until(async () => Boolean(button("Voice", scope)), "the microphone")
  await settle()
  await click(button("Voice", scope))
  await until(async () => Boolean(bar(scope)), "the bar")
  await until(async () => FakeRecorder.slices > 0, "the take's first slice")
}

async function reset(...keys: string[]) {
  await seedSettings()
  await db.drafts.clear()
  await db.dictations.clear()
  for (const key of keys) await db.drafts.put({ id: key, text: "", at: 1 })
}

test("a take shows its meter, the time and the buttons, and no words at all", async () => {
  const sent: { text: string; attachments: Attachment[] }[] = []
  host()
  await reset("c:talking")
  await mount(composer("c:talking", sent), async () => {
    await openTake()
    assert.equal(region(), null, "the bar has no transcript region")
    assert.doesNotMatch(text(), /Let us ship/, "no words anywhere on the bar")
    assert.doesNotMatch(text(), /Transcribing…/, "it is still listening")
    assert.ok(
      button("Stop") && button("Send") && button("Cancel"),
      "Stop, Send and Cancel are there",
    )
    assert.match(bar()?.textContent ?? "", /0:0[0-9]/, "the elapsed time is on the bar")
    const meter = findAll('[aria-live="polite"]')[0]
    assert.equal(
      meter?.querySelectorAll("span").length,
      32,
      "the level waveform is still the meter",
    )

    await click(button("Cancel"))
    await until(async () => Boolean(button("Voice")), "the bar back to idle")
  })
})

test("a Stop lands the tidied take in one write, where the caret was", async () => {
  const sent: { text: string; attachments: Attachment[] }[] = []
  const hosted = host()
  await reset("c:stop")
  await mount(composer("c:stop", sent), async () => {
    await type(field(), "Before after")
    field()!.setSelectionRange(7, 7)
    await openTake()

    await click(button("Stop"))
    await until(
      async () => field()?.value === "Before Let us ship the dictation. after",
      "the tidied take at the caret",
    )
    assert.equal(hosted.cleanups().length, 1, "the host was asked to tidy the take once")
    assert.deepEqual(
      hosted.cleanups()[0].body,
      { text: HEARD, vocabulary: VOCABULARY },
      "the cleanup carries the words the host heard and the bot's vocabulary",
    )
    assert.deepEqual(
      hosted.clips()[0].vocabulary,
      VOCABULARY,
      "every piece's transcription carries the bot's vocabulary",
    )
    assert.equal(sent.length, 0, "a Stop puts the words in the field, it does not send them")
    await until(
      async () => (await db.dictations.count()) === 0,
      "a take that ended keeping nothing on the device",
    )
  })
})

test("a Send waits for the cleanup and sends the tidied take", async () => {
  const sent: { text: string; attachments: Attachment[] }[] = []
  const hosted = host()
  await reset("c:send")
  await mount(composer("c:send", sent), async () => {
    await openTake()

    await click(button("Send"))
    await until(async () => sent.length === 1, "the message sent")
    assert.equal(sent[0].text, TIDIED, "the tidied take is the message")
    assert.equal(hosted.cleanups().length, 1, "the host tidied it before it went")
    await until(async () => Boolean(field()), "the composer is back")
    assert.equal(field()?.value, "", "the message took the words")
  })
})

test("a cleanup that fails lands the words as the host heard them", async () => {
  const sent: { text: string; attachments: Attachment[] }[] = []
  host({ cleanup: "fail" })
  await reset("c:cleanup-fail")
  await mount(composer("c:cleanup-fail", sent), async () => {
    await type(field(), "Before after")
    field()!.setSelectionRange(7, 7)
    await openTake()

    await click(button("Stop"))
    await until(
      async () => field()?.value === `Before ${HEARD} after`,
      "the raw words, filler and all",
    )
    assert.equal(sent.length, 0, "a Stop lands them in the field")
    assert.equal(alert(), null, "a cleanup that fails is not a failed take")
    await until(
      async () => (await db.dictations.count()) === 0,
      "the take ended, keeping nothing",
    )
  })
})

test("a cleanup that answers junk lands the words as the host heard them", async () => {
  const sent: { text: string; attachments: Attachment[] }[] = []
  host({ cleanup: "junk" })
  await reset("c:cleanup-junk")
  await mount(composer("c:cleanup-junk", sent), async () => {
    await openTake()

    await click(button("Send"))
    await until(async () => sent.length === 1, "the message sent")
    assert.equal(sent[0].text, HEARD, "an answer that isn't text is not the take")
  })
})

test("a cleanup that hangs lands the words as the host heard them, inside the wait", async () => {
  const sent: { text: string; attachments: Attachment[] }[] = []
  const hosted = host({ cleanup: "hang" })
  await reset("c:cleanup-hang")
  await mount(composer("c:cleanup-hang", sent), async () => {
    await openTake()
    const started = Date.now()

    await click(button("Send"))
    await until(async () => sent.length === 1, "the message sent", SEND_WAIT_MS + 3000)
    const waited = Date.now() - started
    assert.equal(sent[0].text, HEARD, "the raw words are the fallback")
    assert.equal(hosted.cleanups().length, 1, "the cleanup was still asked for")
    assert.ok(waited < SEND_WAIT_MS + 2500, `the Send was bounded by its wait (${waited} ms)`)
    await until(async () => Boolean(field()), "the composer is back")
  })
})

test("a clip the host never answers gives the composer back inside the wait", async () => {
  const sent: { text: string; attachments: Attachment[] }[] = []
  const hosted = host({ clip: "hang" })
  await reset("c:clip-hang")
  await mount(composer("c:clip-hang", sent), async () => {
    await type(field(), "Before")
    await openTake()
    const started = Date.now()

    await click(button("Send"))
    await until(async () => Boolean(field()), "the composer back", SEND_WAIT_MS + 3000)
    const waited = Date.now() - started
    assert.equal(field()?.value, "Before", "nothing was heard, so nothing lands")
    assert.equal(hosted.cleanups().length, 0, "a take with no words is not tidied")
    assert.ok(waited < SEND_WAIT_MS + 2500, `the Send was bounded by its wait (${waited} ms)`)
  })
})

test("a Cancel while the take is being tidied inserts nothing", async () => {
  const sent: { text: string; attachments: Attachment[] }[] = []
  const hosted = host({ cleanupAfter: 900 })
  await reset("c:cancel")
  await mount(composer("c:cancel", sent), async () => {
    await type(field(), "Before")
    await openTake()

    await click(button("Stop"))
    await until(async () => hosted.cleanups().length === 1, "the cleanup asked for")
    await click(button("Cancel"))
    await until(async () => Boolean(field()), "the composer is back")
    await new Promise((done) => setTimeout(done, 1200))
    assert.equal(field()?.value, "Before", "the draft is as it was")
    assert.equal(sent.length, 0, "nothing was sent")
    await until(async () => (await db.dictations.count()) === 0, "a cancelled take keeping nothing")
  })
})

test("a profile hears one take at a time, and the mic is free once it ends", async () => {
  const sent: { text: string; attachments: Attachment[] }[] = []
  host()
  await reset("c:one", "c:two")
  const both = (
    <div>
      <div data-test="one">{composer("c:one", sent)}</div>
      <div data-test="two">{composer("c:two", sent)}</div>
    </div>
  )
  await mount(both, async () => {
    const one = document.querySelector('[data-test="one"]') as HTMLElement
    const two = document.querySelector('[data-test="two"]') as HTMLElement
    await openTake(one)

    await until(async () => Boolean(button("Voice", two)), "the second composer's microphone")
    await click(button("Voice", two))
    await settle()
    assert.equal(bar(two), null, "the second composer never took the bar")
    assert.ok(field(two), "its field is still its own")

    await click(button("Cancel", one))
    await until(async () => !bar(one), "the first take let go")
    await click(button("Voice", two))
    await until(async () => Boolean(bar(two)), "the second take opened")
    await click(button("Cancel", two))
    await until(async () => !bar(two), "the second take let go")
  })
})

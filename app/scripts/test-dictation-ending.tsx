import assert from "node:assert/strict"
import test from "node:test"

import { Composer } from "@/components/chat/composer"
import { db, type Attachment } from "@/lib/db"
import {
  click,
  connection,
  findAll,
  findText,
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

const composer = (
  draftKey: string,
  sent: { text: string; attachments: Attachment[] }[],
  peer = bot,
) => (
  <Composer
    busy={false}
    onSend={(words, attachments) => {
      sent.push({ text: words, attachments })
    }}
    onQueue={() => {}}
    onStop={() => {}}
    onCommand={() => {}}
    connection={peer}
    files="unknown"
    imagesAvailable
    draftKey={draftKey}
    dictationWords={VOCABULARY}
  />
)

const field = (scope: ParentNode = document) =>
  scope.querySelector("textarea") as HTMLTextAreaElement | null
const bar = (scope: ParentNode = document) =>
  scope.querySelector('[role="group"][aria-label="Speech-to-text take"]')
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
  await db.dictationLog.clear()
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

test("a Stop lands the tidied take from one answer, where the caret was", async () => {
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
    assert.equal(hosted.confirms().length, 1, "the take is answered by one call")
    assert.deepEqual(hosted.confirms()[0].body, { pieces: 1 }, "the Confirm names its Piece count")
    assert.equal(hosted.pieces().length, 1, "one Piece went up, and no other call carried words")
    assert.ok(hosted.pieces()[0].body instanceof Blob, "a Piece is audio and nothing else")
    assert.equal(hosted.pieces()[0].index, 0, "the Piece names its index in the take")
    assert.deepEqual(
      hosted.pieces()[0].vocabulary,
      VOCABULARY,
      "every Piece carries the bot's vocabulary",
    )
    assert.equal(hosted.cancels().length, 0, "a take that landed is not cancelled")
    assert.equal(sent.length, 0, "a Stop puts the words in the field, it does not send them")
    await settle()
    await until(async () => (await db.dictationLog.count()) === 1, "the take in the log")
    const logged = (await db.dictationLog.toArray())[0]
    assert.equal(logged.text, TIDIED, "the row keeps the words that landed")
    assert.equal(logged.heard, HEARD, "and the take as the host heard it, beside them")
    assert.equal(logged.ms, 1000, "the spoken ms is the host's, not the device's own count")
    assert.equal(logged.level, "light", "the row keeps the level that tidied it")
    assert.equal(logged.cleaned, true, "and whether the cleanup changed anything")
    assert.equal(logged.provider, "local", "and who heard it")
    assert.equal(logged.model, "base", "with the model behind it")
    await until(
      async () => (await db.dictations.count()) === 0,
      "a take that ended keeping nothing on the device",
    )
  })
})

test("a Send waits for the answer and sends the tidied take", async () => {
  const sent: { text: string; attachments: Attachment[] }[] = []
  const hosted = host()
  await reset("c:send")
  await mount(composer("c:send", sent), async () => {
    await openTake()

    await click(button("Send"))
    await until(async () => sent.length === 1, "the message sent")
    assert.equal(sent[0].text, TIDIED, "the tidied take is the message")
    assert.equal(hosted.confirms().length, 1, "the host answered the take before it went")
    await until(async () => Boolean(field()), "the composer is back")
    assert.equal(field()?.value, "", "the message took the words")
  })
})

test("an Upload that fails is retried twice before it lands", async () => {
  const sent: { text: string; attachments: Attachment[] }[] = []
  const hosted = host({ uploadFails: [1, 2] })
  await reset("c:retry")
  await mount(composer("c:retry", sent), async () => {
    await openTake()

    await click(button("Stop"))
    await until(async () => field()?.value === TIDIED, "the take lands after two failed Uploads")
    assert.equal(hosted.pieces().length, 3, "the Piece was tried three times")
  })
})

test("a Piece that fails three times fails the take and keeps its audio", async () => {
  const sent: { text: string; attachments: Attachment[] }[] = []
  const hosted = host({ upload: "fail" })
  await reset("c:upload-fails")
  await mount(composer("c:upload-fails", sent), async () => {
    await type(field(), "Before")
    await openTake()

    await click(button("Stop"))
    await until(async () => Boolean(alert()), "the take failed")
    assert.equal(hosted.pieces().length, 3, "three attempts and then the take fails")
    await settle()
    assert.equal(await db.dictationLog.count(), 0, "nothing landed")
    assert.equal(hosted.confirms().length, 0, "a take whose Pieces never went is not confirmed")
    await settle()
    assert.equal(
      (await db.dictations.get("c:upload-fails"))?.pieces.length,
      1,
      "the audio the device holds is kept for a Retry",
    )
  })
})

test("a Confirm that misses the host's bound fails the take and keeps its audio", async () => {
  const sent: { text: string; attachments: Attachment[] }[] = []
  const hosted = host({ confirm: "hang", waitMs: 150 })
  // A bot of its own: `info` is cached per connection for five minutes, so a shorter bound is the one
  // this test's bot states from its first read.
  const bound = connection("dictation-bound")
  await reset("c:bound")
  await mount(composer("c:bound", sent, bound), async () => {
    await type(field(), "Before")
    await openTake()
    const started = Date.now()

    await click(button("Send"))
    await until(async () => Boolean(alert()), "the take gave up", 5000)
    const waited = Date.now() - started
    assert.ok(waited < 3000, `the bar held to the host's bound (${waited} ms)`)
    assert.equal(hosted.confirms().length, 1, "the Confirm was made once, and never answered")
    assert.match(alert()?.textContent ?? "", /didn't answer the take/, "the bar names the wait")
    await settle()
    assert.equal(await db.dictationLog.count(), 0, "nothing landed")
    await settle()
    assert.equal(
      (await db.dictations.get("c:bound"))?.pieces.length,
      1,
      "the take kept its audio for a Retry",
    )
  })
})

test("a Confirm refused for a missing Piece re-sends exactly that Piece and answers", async () => {
  const sent: { text: string; attachments: Attachment[] }[] = []
  const hosted = host({ refuse: 1 })
  await reset("c:refused")
  await mount(composer("c:refused", sent), async () => {
    await openTake()

    await click(button("Stop"))
    await until(async () => field()?.value === TIDIED, "the take recovered and landed")
    assert.equal(hosted.confirms().length, 2, "the take was confirmed again once")
    const resent = hosted.pieces().at(-1)
    assert.equal(resent?.index, 0, "exactly the missing Piece went up again")
    assert.equal(resent?.take, hosted.pieces()[0].take, "under the same Take id")
  })
})

test("a second refusal fails the take", async () => {
  const sent: { text: string; attachments: Attachment[] }[] = []
  const hosted = host({ refuse: 2 })
  await reset("c:refused-twice")
  await mount(composer("c:refused-twice", sent), async () => {
    await type(field(), "Before")
    await openTake()

    await click(button("Stop"))
    await until(async () => Boolean(alert()), "the take failed")
    assert.equal(hosted.confirms().length, 2, "a take gets one re-send, never a third Confirm")
    await settle()
    assert.equal(await db.dictationLog.count(), 0, "nothing landed")
  })
})

test("a Retry sends a fresh Take id and every Piece the device holds", async () => {
  const sent: { text: string; attachments: Attachment[] }[] = []
  const hosted = host({ uploadFails: [1, 2, 3] })
  await reset("c:try")
  await mount(composer("c:try", sent), async () => {
    await openTake()
    await click(button("Stop"))
    await until(async () => Boolean(alert()), "the take failed")
    const dead = hosted.pieces()[0].take
    assert.ok(dead, "the dead take had an id of its own")
    await until(async () => hosted.cancels().length === 1, "the take it could not finish gone")
    assert.equal(
      hosted.cancels()[0].take,
      dead,
      "taken off its bot's host rather than left to expire",
    )

    await click(findText("button", "Retry"))
    await until(async () => field()?.value === TIDIED, "the retried take landed")
    const again = hosted.pieces().at(-1)
    assert.notEqual(again?.take, dead, "the Retry minted a fresh Take id")
    assert.equal(again?.index, 0, "and sent the Piece the device still holds")
    assert.equal(hosted.confirms().at(-1)?.take, again?.take, "the Confirm names the new take")
  })
})

test("a Cancel deletes the take and lands nothing", async () => {
  const sent: { text: string; attachments: Attachment[] }[] = []
  const hosted = host({ confirm: "slow", confirmAfter: 900 })
  await reset("c:cancel")
  await mount(composer("c:cancel", sent), async () => {
    await type(field(), "Before")
    await openTake()

    await click(button("Stop"))
    await until(async () => hosted.confirms().length === 1, "the Confirm asked for")
    await click(button("Cancel"))
    await until(async () => Boolean(field()), "the composer is back")
    await new Promise((done) => setTimeout(done, 1200))
    assert.equal(field()?.value, "Before", "the draft is as it was")
    assert.equal(sent.length, 0, "nothing was sent")
    assert.equal(hosted.cancels().length, 1, "the take was taken off the host at once")
    assert.equal(hosted.cancels()[0].take, hosted.pieces()[0].take, "the take's own id was deleted")
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

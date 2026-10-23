import assert from "node:assert/strict"
import test from "node:test"

import { Composer } from "@/components/chat/composer"
import { db, type Attachment } from "@/lib/db"
import {
  click,
  connection,
  find,
  findAll,
  mount,
  seedSettings,
  settle,
  until,
} from "./component-kit.tsx"
import { dictationHost, installFakeMedia, type DictationHostOptions } from "./fake-dictation.ts"

installFakeMedia()

const bot = connection("dictation-failing")
/** What the speech model wrote down, before the cleanup tidies it. */
const HEARD = "um Let's ship the dictation feature today."
const SENTENCE = "Let's ship the dictation feature today."

/**
 * The host this take meets: the first clip runs out of memory, and the second is heard — the
 * failure Retry is offered for, and the words that land once it is.
 */
function host(options: DictationHostOptions = {}) {
  return dictationHost({
    heard: HEARD,
    tidied: SENTENCE,
    clipFails: [1],
    clipError: "Local transcription failed: the model ran out of memory.",
    ...options,
  })
}

const composer = (draftKey: string, sent: { text: string; attachments: Attachment[] }[]) => (
  <Composer
    busy={false}
    onSend={(text, attachments) => {
      sent.push({ text, attachments })
    }}
    onQueue={() => {}}
    onStop={() => {}}
    onCommand={() => {}}
    connection={bot}
    filesAvailable={false}
    imagesAvailable
    draftKey={draftKey}
  />
)

const field = () => find("textarea") as HTMLTextAreaElement | null
const alert = () => find('[role="alert"]')
const line = () => alert()?.parentElement?.textContent ?? ""
const button = (label: string) =>
  findAll("button").find((one) => one.getAttribute("aria-label") === label) ?? null
const textButton = (label: string) =>
  findAll("button").find((one) => one.textContent?.trim() === label) ?? null

async function failedWith(says: string) {
  await until(
    async () => line().includes(says),
    `the bar to say "${says}" (it says "${line()}", screen: "${(document.body.textContent ?? "").slice(0, 300)}")`,
  )
  return line()
}

async function reset(draftKey: string) {
  await seedSettings()
  await db.profiles.clear()
  await db.profiles.put({
    id: "bot-1",
    name: "A bot",
    baseUrl: bot.baseUrl,
    apiKey: "test-key",
    model: "test/model",
    botId: "bot-1",
    createdAt: 1,
    updatedAt: 1,
  } as never)
  await db.drafts.clear()
  await db.dictations.clear()
  await db.drafts.put({ id: draftKey, text: "", at: 1 })
}

test("a clip the batch route couldn't transcribe says so, and the recording is retried", async () => {
  const sent: { text: string; attachments: Attachment[] }[] = []
  const hosted = host()
  await reset("c:clip")
  await mount(composer("c:clip", sent), async () => {
    await until(async () => Boolean(button("Voice")), "the microphone")
    await settle()
    await click(button("Voice"))
    await until(async () => Boolean(button("Stop")), "the take recording")
    await new Promise((done) => setTimeout(done, 1200))
    await click(button("Stop"))

    const line = await failedWith("Local transcription failed: the model ran out of memory.")
    assert.match(line, /Try again, or type it instead/, "the line says what to try")
    assert.ok(button("Discard"), "its recording is still kept, so it discards")
    assert.equal(hosted.cleanups().length, 0, "a take with no words is not tidied")

    await click(textButton("Retry"))
    await until(async () => field()?.value === SENTENCE, "the clip's words, tidied")
    assert.equal(hosted.clips().length, 2, "the recording was sent again")
    assert.equal(hosted.cleanups().length, 1, "and the take was tidied once it was heard")
    await until(async () => Boolean(button("Voice")), "the bar back to idle")
  })
})

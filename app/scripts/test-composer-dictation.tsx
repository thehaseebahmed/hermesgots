/**
 * What the Speech-to-text page's switch does to the mic in the composer. The switch is on the bot's
 * own page and the mic is in a chat, and the mic is drawn from the host's answer about whether it
 * can hear a take — an answer the device polls once per `DICTATION_INFO_MS` (five minutes). So a chat
 * opened before the switch is flipped goes on saying the host can't dictate until that read comes
 * round again, and a reader who turns speech-to-text on, comes back and finds the same disabled mic
 * reads it as the switch having done nothing.
 *
 * The write is this device's own, so it is followed at once by the read that says what it did
 * (ADR 0164). Each case mounts the chat, then the page, then the chat again over one fake host, so
 * the last mount is the one that would answer from the copy read before the write — and it waits for
 * the mic rather than for the poll, which is the wait the fix shortens.
 */
import assert from "node:assert/strict"
import test from "node:test"
import { act } from "react"

import { Composer } from "@/components/chat/composer"
import { connectionKey, noteChange } from "@/lib/live"

import { click, connection, find, missing, mount, until } from "./component-kit.tsx"
import { STT, editor, seed, speech, switchIn, writes } from "./dictation-page-kit.tsx"
import { installFakeMedia } from "./fake-dictation.ts"

/** The mic the composer offers, and the one it draws greyed with the host's reason instead. */
const MIC = '[aria-label="Voice"]'
const UNAVAILABLE = '[aria-label="Speech-to-text unavailable"]'

const composer = (name: string) => (
  <Composer
    busy={false}
    onSend={() => {}}
    onQueue={() => {}}
    onStop={() => {}}
    onCommand={() => {}}
    connection={connection(name)}
    filesFeature="yes"
    imagesAvailable
  />
)

/** The host's settings block with the master switch at `on`: every other setting as it ships. */
const sttWith = (on: boolean) => STT({ values: { ...STT().values, "stt.enabled": on } })

/** The switch flipped on the bot's page, read back once the host's answer has landed. */
async function flip(calls: { method: string }[], to: boolean) {
  await mount(editor("/settings/bots/bot-1/speech-to-text"), async () => {
    await click(switchIn("stt.enabled"))
    await until(async () => writes(calls).length === 1, "the write to go out")
    await until(
      async () => switchIn("stt.enabled")?.getAttribute("aria-checked") === String(to),
      "the row to read the host's answer",
    )
  })
}

test("flipping the switch on puts the mic in a chat opened afterwards, without waiting the read", async () => {
  installFakeMedia()
  const calls = await seed(
    "mic-on",
    ["dictation", "speech_model", "stt_settings"],
    {},
    { speech: speech({ stt: sttWith(false) }), nextStt: sttWith(true) },
  )

  await mount(composer("mic-on"), async () => {
    assert.ok(find(UNAVAILABLE), "the mic says the host can't dictate")
    assert.ok(missing(MIC), "and there is no microphone to press")
  })

  await flip(calls, true)

  await mount(composer("mic-on"), async () => {
    await until(async () => Boolean(find(MIC)), "the composer to offer the microphone")
    assert.ok(missing(UNAVAILABLE), "and nothing says the host can't dictate")
  })
})

test("flipping the switch off takes the mic away from a chat opened afterwards", async () => {
  installFakeMedia()
  const calls = await seed(
    "mic-off",
    ["dictation", "speech_model", "stt_settings"],
    {},
    { speech: speech({ stt: sttWith(true) }), nextStt: sttWith(false) },
  )

  await mount(composer("mic-off"), async () => {
    assert.ok(find(MIC), "the host can hear a take, so the mic is there")
    assert.ok(missing(UNAVAILABLE), "and nothing is drawn in its place")
  })

  await flip(calls, false)

  await mount(composer("mic-off"), async () => {
    await until(async () => missing(MIC), "the microphone to go")
    assert.ok(find(UNAVAILABLE), "and the host's reason to stand where it was")
  })
})

test("a chat already open takes a setting written on another device, on the stream's frame", async () => {
  installFakeMedia()
  await seed(
    "mic-live",
    ["dictation", "speech_model", "stt_settings"],
    {},
    { speech: speech({ stt: sttWith(false) }), nextStt: sttWith(true) },
  )
  const bot = connection("mic-live")

  await mount(composer("mic-live"), async () => {
    assert.ok(find(UNAVAILABLE), "the host can't hear a take yet")
    // Another device wrote the switch: the fake host answers the write the way a host does, and the
    // stream says so. The composer was never remounted, which is the case ADR 0164's frame is for.
    await act(async () => {
      await fetch(`${bot.baseUrl.replace("/v1", "")}/api/plugins/gots/stt`, {
        method: "POST",
        body: JSON.stringify({ key: "stt.enabled", value: true }),
      })
    })
    await act(async () => noteChange(connectionKey(bot), "settings"))
    await until(async () => Boolean(find(MIC)), "the composer to take the other device's write")
    assert.ok(missing(UNAVAILABLE), "and nothing says the host can't dictate")
  })
})

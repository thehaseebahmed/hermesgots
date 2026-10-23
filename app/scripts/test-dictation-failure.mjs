import assert from "node:assert/strict"
import test from "node:test"

import {
  blockedMicrophone,
  clipFailure,
  failure,
  failureLine,
  microphoneFailure,
  startFailure,
  takeFailure,
} from "../src/lib/dictation-failure.ts"

/** A host's own refusal: Hermes's error shape, which carries the status it answered with. */
const refused = (status, message) => Object.assign(new Error(message), { status })

const aborted = () => new DOMException("The wait ran out.", "AbortError")

test("a take the host refuses says the host's own reason and what to try", () => {
  const failed = startFailure(refused(409, "This Hermes can't decode audio while it is spoken."))
  assert.equal(failed.message, "This Hermes can't decode audio while it is spoken.")
  assert.match(failed.advice, /host can dictate/)
  assert.equal(failed.retry, true, "a refusal can be tried again")
  assert.equal(failed.discard, false, "nothing was recorded, so there is nothing to discard")
})

test("a speech model that won't load is its own failure, with the picker as the next thing to try", () => {
  const failed = startFailure(refused(502, "The host couldn't load its small speech model: no file"))
  assert.equal(failed.message, "The host couldn't load its small speech model: no file")
  assert.match(failed.advice, /speech model on the Dictation tab/)
  assert.equal(failed.retry, true)
})

test("a start that never answers is a host failure, not a hang", () => {
  const failed = startFailure(aborted())
  assert.equal(failed.message, "The bot's host didn't answer in time.")
  assert.match(failed.advice, /host is running/)
})

test("a host that goes away mid-take says so, and the take's words are already the user's", () => {
  const gone = takeFailure(refused(410, "This dictation has ended."))
  assert.equal(gone.message, "This dictation has ended.")
  assert.match(gone.advice, /host is running/)
  const lost = takeFailure(new TypeError("Failed to fetch"))
  assert.equal(lost.message, "Couldn't hear the recording.", "the transport's own words are no use")
  assert.match(lost.advice, /host is running/)
  const waited = takeFailure(aborted())
  assert.equal(waited.message, "The bot took too long to hear the dictation.")
})

test("a host that can't decode says the take's words are kept, and a clip the batch route failed keeps its audio", () => {
  const decode = takeFailure(refused(502, "Couldn't decode the recording: bad container"))
  assert.equal(decode.message, "Couldn't decode the recording: bad container")
  assert.match(decode.advice, /words it already heard are kept/)
  const clip = clipFailure(refused(502, "Local transcription failed: the model ran out of memory."))
  assert.equal(clip.message, "Local transcription failed: the model ran out of memory.")
  assert.equal(clip.discard, true, "its recording is still on the device, so closing it discards")
  assert.match(clipFailure(aborted()).message, /took too long to transcribe/)
})

test("a microphone whose permission is the problem offers no retry, and one another app holds does", () => {
  const blocked = microphoneFailure("Microphone access is blocked.", blockedMicrophone(new DOMException("no", "NotAllowedError")))
  assert.equal(blocked.retry, false, "only the user can grant it")
  assert.match(blocked.advice, /microphone in this app's permissions/)
  const taken = microphoneFailure("The microphone is in use by another app.", blockedMicrophone(new DOMException("no", "NotReadableError")))
  assert.equal(taken.retry, true)
  assert.equal(blockedMicrophone(new Error("anything else")), false)
})

test("the bar reads both sentences, and a kind's advice is its own", () => {
  const failed = failure("decode", "Couldn't decode the recording.")
  assert.equal(failureLine(failed), `${failed.message} ${failed.advice}`)
  assert.notEqual(failure("host", "x").advice, failure("clip", "x").advice)
  assert.equal(failure("host", "x", { discard: true }).discard, true)
  assert.equal(failure("host", "x", { retry: false }).retry, false)
  assert.equal(failure("host", "x", { advice: "Try once more." }).advice, "Try once more.")
})

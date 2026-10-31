import assert from "node:assert/strict"
import test from "node:test"

import {
  blockedMicrophone,
  clipFailure,
  failure,
  failureLine,
  microphoneFailure,
} from "../src/lib/dictation-failure.ts"

/** A host's own refusal: Hermes's error shape, which carries the status it answered with. */
const refused = (status, message) => Object.assign(new Error(message), { status })

const aborted = () => new DOMException("The wait ran out.", "AbortError")

test("a take the host failed keeps its audio, in the host's own words", () => {
  const clip = clipFailure(refused(502, "Local transcription failed: the model ran out of memory."))
  assert.equal(clip.message, "Local transcription failed: the model ran out of memory.")
  assert.equal(clip.discard, true, "its audio is still on the device, so closing it discards")
  assert.match(clip.advice, /Try again, or type it instead/)
})

test("a take past the host's bound says so, with the number the host stated", () => {
  assert.equal(clipFailure(aborted(), 38_000).message, "The bot didn't answer the take in 38 s.")
  assert.equal(clipFailure(aborted(), 150).message, "The bot didn't answer the take in 150 ms.")
  assert.equal(clipFailure(aborted()).message, "The bot didn't answer the take.")
})

test("a transport failure is not a sentence to show a person, so the take says its own", () => {
  const lost = clipFailure(new TypeError("Failed to fetch"))
  assert.equal(lost.message, "Couldn't reach the bot's host to finish the take.")
  assert.match(lost.advice, /Try again, or type it instead/)
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
  const failed = failure("clip", "Couldn't transcribe the recording.")
  assert.equal(failureLine(failed), `${failed.message} ${failed.advice}`)
  assert.notEqual(failure("host", "x").advice, failure("clip", "x").advice)
  assert.equal(failure("host", "x", { discard: true }).discard, true)
  assert.equal(failure("host", "x", { retry: false }).retry, false)
  assert.equal(failure("host", "x", { advice: "Try once more." }).advice, "Try once more.")
})

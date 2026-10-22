import assert from "node:assert/strict"
import test from "node:test"

import {
  audioType,
  CHUNK_BYTES,
  chunkCount,
  clock,
  length,
  parseTranscript,
  stampSeconds,
} from "../src/lib/meeting-text.ts"

test("WebVTT cues become lines at their start, and the last end sets the length", () => {
  const { lines, duration, timed } = parseTranscript(
    "WEBVTT\n\n1\n00:00:01.000 --> 00:00:04.000\nWelcome <b>all</b>.\n\n00:00:05.500 --> 00:00:09.250\nWhat went well?\n",
  )
  assert.deepEqual(
    lines.map((l) => [l.at, l.text]),
    [
      [1, "Welcome all."],
      [5, "What went well?"],
    ],
  )
  assert.equal(duration, 9)
  assert.equal(timed, true)
})

test("lines that start with a time keep it, with or without brackets and hours", () => {
  const { lines } = parseTranscript("[00:03] Alex: Hi\n0:21 - Sam: Hello\n1:02:05 Closing")
  assert.deepEqual(
    lines.map((l) => l.at),
    [3, 21, 3725],
  )
  assert.equal(lines[1].text, "Sam: Hello")
})

test("text with no times is spread at a speaking pace and says so", () => {
  const { lines, timed, duration } = parseTranscript("One two three.\nFour five six seven eight nine ten.")
  assert.equal(timed, false)
  assert.equal(lines[0].at, 0)
  assert.ok(lines[1].at >= 2)
  assert.ok(duration > lines[1].at)
})

test("a stamp from the host reads back to seconds, and anything else is nothing", () => {
  assert.equal(stampSeconds("12:04"), 724)
  assert.equal(stampSeconds("1:02:04"), 3724)
  assert.equal(stampSeconds("[12:04]"), undefined)
  assert.equal(stampSeconds("soon"), undefined)
})

test("clock and length", () => {
  assert.equal(clock(65), "1:05")
  assert.equal(clock(3725), "1:02:05")
  assert.equal(length(40), "40 s")
  assert.equal(length(3720), "1 h 2 min")
})

test("a recording goes in chunks under the host's limit", () => {
  assert.equal(chunkCount(0), 1)
  assert.equal(chunkCount(CHUNK_BYTES), 1)
  assert.equal(chunkCount(CHUNK_BYTES + 1), 2)
  assert.ok(CHUNK_BYTES < 9 * 1024 * 1024)
})

test("the content type is the file's own, tidied, else by extension", () => {
  assert.equal(audioType("a.m4a", "audio/x-m4a"), "audio/mp4")
  assert.equal(audioType("a.bin", "audio/mpeg; codecs=x"), "audio/mpeg")
  assert.equal(audioType("call.M4A", ""), "audio/mp4")
  assert.equal(audioType("call.wav", ""), "audio/wav")
  assert.equal(audioType("call", ""), "audio/webm")
})

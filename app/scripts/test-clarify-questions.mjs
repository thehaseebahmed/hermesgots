/**
 * The call a live question came out of. Hermes asks a call's questions one prompt at a time, so the
 * prompt names one question; the call row the agent wrote is the only place the set survives.
 *
 * The arguments and questions below are the ones a real run on this host wrote — a clarify call with
 * four questions, asked as four prompts — cut to the three a phone has to page through.
 */
import assert from "node:assert/strict"
import test from "node:test"

import { questionsAround, questionsOf } from "../src/lib/clarify-questions.ts"

const ASKED = JSON.stringify({
  questions: [
    {
      question: "The card family's two looks:",
      choices: [
        "Keep the split: a card that waits on you floats and wears its own colour; a card that records what happened lies flat and muted",
        "One shell and one header for every card, asking or recorded, so the family is one piece",
      ],
    },
    {
      question: 'The "Recommended" badge:',
      choices: [
        "Keep it: a badge on the suggested choice, which never has to be picked",
        "Drop the badge and tint the suggested choice's row instead, so the recommendation is part of the choice rather than a stamp on it",
      ],
    },
    {
      question: "The reason a send was refused, which the thread never shows once the toast has gone:",
      choices: [
        'Keep it out: the row says "Not sent" and no more, as ADR 0071 has it',
        "Put the reason in the row under the bubble, muted and truncated, so a reader coming back later knows why",
      ],
      multi_select: false,
    },
  ],
})

const row = (name, argumentsText) => ({
  tool_calls: [{ function: { name, arguments: argumentsText } }],
})

test("the questions a question belongs to are the call's that put it", () => {
  const questions = questionsOf(ASKED)
  assert.equal(questions.length, 3)
  assert.equal(questions[0].id, "q0", "a question without an id of its own is numbered by its place")
  assert.ok(questions[0].choices?.length, "its choices come with it")

  assert.deepEqual(
    questionsAround('The "Recommended" badge:', [row("clarify", ASKED)])?.map((one) => one.question),
    [
      "The card family's two looks:",
      'The "Recommended" badge:',
      "The reason a send was refused, which the thread never shows once the toast has gone:",
    ],
    "the whole call comes back, in the order the agent put it",
  )
})

test("a question no call put is no set at all", () => {
  assert.equal(questionsAround("Which logs count as old?", [row("clarify", ASKED)]), undefined)
  assert.equal(questionsAround("Which logs count as old?", []), undefined)
})

test("only a clarify call's questions count, and the newest call that put one wins", () => {
  assert.equal(
    questionsAround("Later", [
      row("terminal", JSON.stringify({ questions: [{ question: "Later" }] })),
    ]),
    undefined,
    "a call that is not the clarify tool asks nothing",
  )
  const rows = [
    row("clarify", JSON.stringify({ questions: [{ question: "Earlier" }] })),
    row("clarify", JSON.stringify({ questions: [{ question: "Later" }] })),
  ]
  assert.deepEqual(
    questionsAround("Later", rows)?.map((one) => one.question),
    ["Later"],
    "the newest call holding the question is the one read",
  )
})

test("arguments the transcript cut short, or never wrote, ask nothing", () => {
  assert.deepEqual(questionsOf(""), [])
  assert.deepEqual(questionsOf('{"questions": [{"question": "unfin'), [])
  assert.deepEqual(questionsOf('{"questions": []}'), [])
  assert.deepEqual(questionsOf('{"questions": [{"question": "  "}]}'), [])
})

test("a question the agent asked alone is still a set, of one", () => {
  const alone = JSON.stringify({ questions: [{ question: "Which environment?" }] })
  assert.deepEqual(questionsAround("Which environment?", [row("clarify", alone)]), [
    { id: "q0", question: "Which environment?" },
  ])
})

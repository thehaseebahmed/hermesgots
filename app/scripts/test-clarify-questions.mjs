/**
 * The call a live question came out of. Hermes asks a call's questions one prompt at a time, so the
 * prompt names one question; the call row the agent wrote is the only place the set survives.
 *
 * The arguments and questions below are the ones a real run on this host wrote — a clarify call with
 * four questions, asked as four prompts — cut to the three a phone has to page through.
 */
import assert from "node:assert/strict"
import test from "node:test"

import { clarifyRead, clarifyResult, clarifyUnwire, clarifyWire, questionAt } from "../src/lib/clarify.ts"
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

test("a question Hermes words with its own hint after it is still the question the call put", () => {
  // Hermes 0.23.1 adds a newline and a localized "skip" hint to every question it asks off its own
  // local viewers, so the prompt's words are the row's, then more.
  const set = questionsOf(ASKED)
  const hinted = `${set[1].question}\nReply "skip" to skip this question.`
  assert.equal(questionAt(set, hinted), 1)
  assert.equal(questionsAround(hinted, [row("clarify", ASKED)])?.length, set.length)
  assert.equal(
    questionAt(set, `${set[1].question} and more`),
    -1,
    "words run on are another question",
  )
})

test("an exact match wins over a question that is another's first line", () => {
  const set = [
    { id: "q0", question: "Which?\nThe long one" },
    { id: "q1", question: "Which?" },
  ]
  assert.equal(questionAt(set, "Which?\nThe long one"), 0)
  assert.equal(questionAt(set, "Which?"), 1)
  assert.equal(questionAt(set, "Which?\nReply skip"), 1)
})

test("a response of Hermes's own word for a skip reads as a question skipped", () => {
  // Through Hermes 0.23.1's run route a skipped question comes back answered, as the word it was
  // sent with.
  const result = (responses) => JSON.stringify({ responses, outcome: "submitted" })
  const read = clarifyRead(
    result([
      {
        question: "Which colour?",
        choices_offered: ["Red", "Blue"],
        status: "answered",
        user_response: "Red",
      },
      {
        question: "Which size?",
        choices_offered: ["Small", "Large"],
        status: "answered",
        user_response: "skip",
      },
      {
        question: "Any notes?",
        choices_offered: null,
        status: "answered",
        user_response: " Skip ",
      },
      { question: "Why?", choices_offered: null, status: "answered", user_response: "skip it" },
    ]),
  )
  assert.deepEqual(
    read.asked.map((one) => one.answers),
    [["Red"], [], [], ["skip it"]],
    "the word alone is a skip, whatever its case; a sentence with it in is an answer",
  )
  const offered = clarifyRead(
    result([
      {
        question: "Next?",
        choices_offered: ["go", "skip"],
        status: "answered",
        user_response: "skip",
      },
    ]),
  )
  assert.deepEqual(offered.asked[0].answers, ["skip"], "a choice the question offered is an answer")
})

test("an answer goes to Hermes's run route in the shape it reads back", () => {
  // Hermes splits a multi-select answer only when it is a JSON list: picks joined with a comma were
  // recorded as one choice, "Auth, Search".
  assert.equal(clarifyWire(["Auth", "Search"]), '["Auth","Search"]', "several picks are a list")
  assert.equal(clarifyWire(["Auth, with a comma"]), '["Auth, with a comma"]', "one pick is too")
  assert.equal(clarifyWire("Postgres"), "Postgres", "one answer is its words")
  assert.equal(clarifyWire(null), "", "a skipped question has none")
  assert.equal(clarifyWire([]), "", "and so has one with nothing picked")
})

test("an answer the app recorded for itself reads as the picks it sent, not the JSON they went as", () => {
  const sent = clarifyWire(["Auth", "Search"])
  assert.deepEqual(clarifyUnwire(sent, true), ["Auth", "Search"], "a list sent is a list kept")
  assert.deepEqual(clarifyUnwire("typed it", true), ["typed it"], "an Other typed alone is one pick")
  assert.equal(clarifyUnwire("Postgres", false), "Postgres", "one answer is its words")
  assert.equal(clarifyUnwire('["a"]', false), '["a"]', "a single-select answer is never parsed")
  assert.equal(clarifyUnwire("", true), null, "a skipped question has none")
  const read = clarifyRead(
    clarifyResult(
      [{ question: "Which features?", choicesOffered: ["Auth", "Search"], answer: clarifyUnwire(sent, true) }],
      "submitted",
    ),
  )
  assert.deepEqual(read.asked[0].answers, ["Auth", "Search"], "the thread draws two picks")
})

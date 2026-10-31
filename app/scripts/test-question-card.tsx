/**
 * The card the agent's questions are answered on. It never grows past half the screen, so a question
 * longer than that scrolls inside it instead of taking the card's own buttons away; several
 * questions are pages of it, moved by the arrows beside their count; any question may be skipped;
 * and a question that came with choices always offers an Other beside them.
 */
import assert from "node:assert/strict"
import test from "node:test"

import { QuestionCard } from "@/components/chat/question-card"
import type { ClarifyAnswers, ClarifyQuestion, Message } from "@/lib/db"
import { click, find, findAll, findText, mount, settle, text, type } from "./component-kit.tsx"

const message = (questions: ClarifyQuestion[]): Message => ({
  id: "m-1",
  conversationId: "c-1",
  role: "assistant",
  content: "",
  status: "streaming",
  createdAt: 1,
  clarify: { runId: "r-1", clarifyId: "c-1", questions },
})

const answers: ClarifyAnswers[] = []
const answered = () => answers.splice(0, answers.length)

/** The row the pages scroll in, given the width and the scroll a browser lands a page at. */
function pagesRow() {
  const row = find("[data-question-pages]") as HTMLElement
  Object.defineProperty(row, "clientWidth", { value: 320, configurable: true })
  row.scrollTo = ((options: ScrollToOptions) => {
    row.scrollLeft = Number(options.left ?? 0)
    row.dispatchEvent(new Event("scroll"))
  }) as typeof row.scrollTo
  return row
}

const inert = (page: number) => find(`[data-question-page="${page}"]`)?.hasAttribute("inert")
const arrow = (label: string) => find(`[aria-label="${label}"]`) as HTMLButtonElement | null

test("a question longer than the screen scrolls inside a card that stops at half of it", async () => {
  const choices = Array.from({ length: 12 }, (_, at) => `Older than ${at + 1} days`)
  await mount(
    <QuestionCard
      message={message([{ id: "q0", question: "Which logs should I count as old?", choices }])}
      onAnswer={async () => {}}
    />,
    async () => {
      const card = find("[data-slot=card]")!
      assert.match(
        card.className,
        /max-h-\[50dvh\]/,
        "the card is capped at half the screen, so its buttons stay on it",
      )
      const body = card.querySelector('[data-slot="card-content"]')!
      assert.match(body.className, /overflow-y-auto/, "and the question itself scrolls")
      assert.ok(findText("[data-slot=button]", "Skip"), "a question can be skipped")
      assert.ok(findText("[data-slot=button]", "Other"), "and answered with one of its own")
      assert.ok(findText("[data-slot=button]", "Send"), "and sent once answered")
      assert.equal(findAll("[data-question-pages]").length, 0, "one question is no pager")
    },
  )
})

test("several questions are pages of one card, with arrows beside their count", async () => {
  answered()
  await mount(
    <QuestionCard
      message={message([
        { id: "q0", question: "Which environment?", choices: ["staging", "production"] },
        { id: "q1", question: "What should the change be called?" },
        { id: "q2", question: "Who reviews it?", choices: ["Platform", "Product"] },
      ])}
      onAnswer={async (given) => {
        answers.push(given)
      }}
    />,
    async () => {
      pagesRow()
      assert.match(text(), /Questions1 of 3/, "all three are one card, counted")
      assert.equal(inert(0), false, "the first is the page showing")
      assert.equal(inert(1), true, "and the rest wait their turn")
      assert.equal(arrow("Previous question")?.disabled, true, "nothing comes before the first")
      assert.ok(findText("[data-slot=button]", "Skip"), "the first page can be skipped")

      await click(arrow("Next question"))
      assert.match(text(), /2 of 3/, "the arrow moves on")
      assert.equal(inert(0), true, "the first page is put away")
      assert.equal(inert(1), false, "and the second is the one showing")

      await click(arrow("Previous question"))
      assert.match(text(), /1 of 3/, "and back")

      // Skip takes the question as it stands and moves on, answering nothing.
      await click(findText("[data-slot=button]", "Skip"))
      await settle()
      assert.match(text(), /2 of 3/, "Skip moves to the next question")
      assert.equal(answers.length, 0, "and nothing is sent until the last one")
    },
  )
})

test("skipping the last question sends the form with that one left blank", async () => {
  answered()
  await mount(
    <QuestionCard
      message={message([
        { id: "q0", question: "Which environment?", choices: ["staging", "production"] },
        { id: "q1", question: "What should the change be called?" },
      ])}
      onAnswer={async (given) => {
        answers.push(given)
      }}
    />,
    async () => {
      pagesRow()
      await click(findText("[data-slot=button]", "staging"))
      await click(arrow("Next question"))
      assert.match(text(), /2 of 2/)
      assert.equal(arrow("Next question")?.disabled, true, "there is no page after the last")
      await click(findText("[data-slot=button]", "Skip"))
      await settle()
      assert.deepEqual(answers, [{ q0: "staging", q1: null }], "the skipped question is null")
      assert.doesNotMatch(text(), /No answer/, "the form never reads as missed here")
    },
  )
})

test("a question with one choice still offers an Other, and its words are the answer", async () => {
  answered()
  await mount(
    <QuestionCard
      message={message([{ id: "q0", question: "Which group?", choices: ["Old logs"] }])}
      onAnswer={async (given) => {
        answers.push(given)
      }}
    />,
    async () => {
      assert.ok(findText("[data-slot=button]", "Old logs"), "the host's choice is offered")
      assert.equal(
        findAll("[data-slot=button]").filter((one) => one.textContent === "Other").length,
        1,
        "one Other, beside the choices",
      )
      await click(findText("[data-slot=button]", "Other"))
      await type(find('input[placeholder="Type your answer"]'), "logs from the old cluster")
      await click(findText("[data-slot=button]", "Send"))
      await settle()
      assert.deepEqual(answers, [{ q0: "logs from the old cluster" }], "the typed answer is sent")
    },
  )
})

test("an open-ended question is its own answer, with no choices to pick", async () => {
  answered()
  await mount(
    <QuestionCard
      message={message([{ id: "q0", question: "What should the change be called?" }])}
      onAnswer={async (given) => {
        answers.push(given)
      }}
    />,
    async () => {
      assert.equal(
        findAll("[data-slot=button]").filter((one) => one.textContent === "Other").length,
        0,
      )
      await type(find("textarea"), "a rename")
      await click(findText("[data-slot=button]", "Send"))
      await settle()
      assert.deepEqual(answers, [{ q0: "a rename" }])
    },
  )
})

/**
 * The card the agent's questions are answered on. It never grows past half the screen, so a question
 * longer than that scrolls inside it instead of taking the card's own buttons away; several
 * questions are pages of it, moved by the arrows beside their count; any question may be skipped;
 * and a question that came with choices always offers an Other beside them.
 */
import assert from "node:assert/strict"
import test from "node:test"
import { act, useEffect, useState } from "react"

import { QuestionCard } from "@/components/chat/question-card"
import type { ClarifyAnswers, ClarifyQuestion, Message } from "@/lib/db"
import {
  click,
  find,
  findAll,
  findText,
  mount,
  settle,
  text,
  type,
  withToasts,
} from "./component-kit.tsx"

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

const threeAsked: ClarifyQuestion[] = [
  { id: "q0", question: "Which environment?", choices: ["staging", "production"] },
  { id: "q1", question: "What should the change be called?" },
  { id: "q2", question: "Who reviews it?", choices: ["Platform", "Product"] },
]

/**
 * A host that asks a call's questions one prompt at a time, as Hermes's run route does: it names the
 * question it waits on, holds the card between one answer and its next prompt, and moves on when the
 * test says it has asked again. The card is kept mounted across the prompts, as chat-next keeps it.
 */
function askingHost(ask: ClarifyQuestion[], onAnswer: (given: ClarifyAnswers) => Promise<void>) {
  const host = {
    /** The host asks the next question: the one it waits on moves, and the hold lifts. */
    ask: (_id: string) => {},
    /** The asked question is answered and the next has yet to be asked. */
    hold: () => {},
  }
  function Host() {
    const [asked, setAsked] = useState(ask[0].id)
    const [held, setHeld] = useState(false)
    useEffect(() => {
      host.ask = (id) => {
        setAsked(id)
        setHeld(false)
      }
      host.hold = () => setHeld(true)
    }, [])
    return <QuestionCard message={message(ask)} askedId={asked} held={held} onAnswer={onAnswer} />
  }
  return { host, element: <Host /> }
}

const button = (label: string) => findText("[data-slot=button]", label) as HTMLButtonElement | null
const pressed = (label: string) => button(label)?.getAttribute("aria-pressed")

test("a host that asks one question at a time draws the whole ask, and the asked question goes first when the form is sent", async () => {
  answered()
  await mount(
    <QuestionCard
      message={message(threeAsked)}
      askedId="q1"
      onAnswer={async (given) => {
        answers.push(given)
      }}
    />,
    async () => {
      pagesRow()
      assert.match(text(), /Questions2 of 3/, "the card opens on the question the host asks")
      assert.equal(inert(1), false, "that is the page showing")
      assert.equal(
        button("staging")?.disabled,
        true,
        "a question the host has already taken is answered and stays so",
      )
      assert.equal(button("Platform")?.disabled, false, "one the host has yet to ask can be chosen")
      assert.equal(arrow("Next question")?.disabled, false, "the arrows still read the whole ask")

      await type(find("textarea") as HTMLTextAreaElement, "rename it")
      assert.ok(!button("Send"), "a page before the last moves on rather than sending")
      await click(button("Next"))
      assert.match(text(), /3 of 3/)
      assert.deepEqual(answers, [], "and moving on sends nothing")

      await click(button("Platform"))
      await click(button("Send"))
      await settle()
      assert.deepEqual(answers, [{ q1: "rename it" }], "the host's own question goes first, alone")
    },
  )
})

test("a question chosen ahead is held until the host asks it, then sent with no tap", async () => {
  answered()
  const ask = [
    { id: "q0", question: "Which environment?", choices: ["staging", "production"] },
    { id: "q1", question: "Who reviews it?", choices: ["Platform", "Product"] },
  ]
  const { host, element } = askingHost(ask, async (given) => {
    answers.push(given)
  })
  await mount(element, async () => {
    pagesRow()
    await settle()
    await click(arrow("Next question"))
    assert.match(text(), /2 of 2/)
    await click(button("Product"))
    assert.deepEqual(answers, [], "a choice made ahead sends nothing")

    await click(arrow("Previous question"))
    assert.match(text(), /1 of 2/)
    await click(button("staging"))
    await click(button("Next"))
    assert.match(text(), /2 of 2/)
    assert.equal(pressed("Product"), "true", "the choice made ahead is still there")
    await click(button("Send"))
    await settle()
    assert.deepEqual(answers, [{ q0: "staging" }], "only the asked question goes at first")

    await act(async () => host.ask("q1"))
    await settle()
    assert.deepEqual(
      answers,
      [{ q0: "staging" }, { q1: "Product" }],
      "asked now, the choice made ahead goes without another tap",
    )
  })
})

test("a host that asks one question at a time is answered through the whole form, with Next until the last page", async () => {
  answered()
  await mount(
    <QuestionCard
      message={message(threeAsked)}
      askedId="q0"
      onAnswer={async (given) => {
        answers.push(given)
      }}
    />,
    async () => {
      pagesRow()
      await settle()
      assert.match(text(), /1 of 3/)
      await click(button("staging"))
      assert.ok(!button("Send"), "the first page has no Send")
      assert.ok(button("Next"), "its main button is Next")
      await click(button("Next"))
      assert.match(text(), /2 of 3/, "Next moves to the second question")
      assert.deepEqual(answers, [], "and sends nothing")

      await type(find("textarea") as HTMLTextAreaElement, "rename it")
      assert.ok(!button("Send"), "the second page has no Send either")
      await click(button("Next"))
      assert.match(text(), /3 of 3/, "Next moves to the last question")
      assert.ok(button("Send"), "where the form is sent")
      assert.deepEqual(answers, [], "and nothing has gone yet")
    },
  )
})

test("a page ahead of the asked one can be answered and the form sent from it", async () => {
  answered()
  await mount(
    <QuestionCard
      message={message(threeAsked)}
      askedId="q0"
      onAnswer={async (given) => {
        answers.push(given)
      }}
    />,
    async () => {
      pagesRow()
      await settle()
      await click(arrow("Next question"))
      await click(arrow("Next question"))
      assert.match(text(), /3 of 3/, "the arrows reach the last page while the host asks the first")
      assert.equal(button("Skip")?.disabled, false, "Skip is live there")
      await click(button("Product"))
      assert.equal(button("Send")?.disabled, false, "and so is Send, once it is answered")
    },
  )
})

test("a host that asks one question at a time takes the whole form, sending each answer as it is asked", async () => {
  answered()
  const { host, element } = askingHost(threeAsked, async (given) => {
    answers.push(given)
  })
  await mount(element, async () => {
    pagesRow()
    await settle()
    await click(button("staging"))
    await click(button("Next"))
    await type(find("textarea") as HTMLTextAreaElement, "rename it")
    await click(button("Next"))
    await click(button("Product"))
    await click(button("Send"))
    await settle()
    assert.deepEqual(answers, [{ q0: "staging" }], "Send answers the question the host asks")

    await act(async () => host.hold())
    await settle()
    assert.deepEqual(answers, [{ q0: "staging" }], "nothing goes while the host is held")

    await act(async () => host.ask("q1"))
    await settle()
    assert.deepEqual(
      answers,
      [{ q0: "staging" }, { q1: "rename it" }],
      "the next question is answered as soon as it is asked, with no tap",
    )
    assert.equal(button("Next")?.disabled, true, "and the form can't be paged while it goes")

    await act(async () => host.hold())
    await settle()
    assert.equal(answers.length, 2, "and nothing more while held again")

    await act(async () => host.ask("q2"))
    await settle()
    assert.deepEqual(
      answers,
      [{ q0: "staging" }, { q1: "rename it" }, { q2: "Product" }],
      "and the last as soon as it is asked",
    )
  })
})

test("an answer the host refuses stops the drain on the asked page, with the rest still filled", async () => {
  answered()
  const { host, element } = askingHost(threeAsked, async (given) => {
    answers.push(given)
    throw new Error("The host refused the answer.")
  })
  await withToasts(async (said) => {
    await mount(element, async () => {
      pagesRow()
      await settle()
      await click(button("staging"))
      await click(button("Next"))
      await type(find("textarea") as HTMLTextAreaElement, "rename it")
      await click(button("Next"))
      await click(button("Product"))
      await click(button("Send"))
      await settle()
      assert.deepEqual(answers, [{ q0: "staging" }], "the asked question was tried")
      assert.deepEqual(said, ["The host refused the answer."], "and the refusal said")
      assert.match(text(), /1 of 3/, "the card is back on the asked page")
      assert.equal(pressed("staging"), "true", "with its answer still picked")
      assert.equal(
        (find("textarea") as HTMLTextAreaElement).value,
        "rename it",
        "and the other pages still filled",
      )
      assert.equal(pressed("Product"), "true")

      await act(async () => host.ask("q1"))
      await settle()
      assert.equal(answers.length, 1, "a refused form is not sent on when the host moves")
    })
  })
})

test("the card opens on the page the host asks, not on the first of the ask", async () => {
  answered()
  const ask = [
    { id: "q0", question: "Which environment?", choices: ["staging", "production"] },
    { id: "q1", question: "Who reviews it?", choices: ["Platform", "Product"] },
  ]
  await mount(
    <QuestionCard message={message(ask)} askedId="q1" onAnswer={async () => {}} />,
    async () => {
      pagesRow()
      assert.match(text(), /2 of 2/, "the second question is the one showing")
      assert.equal(inert(0), true, "the one already answered is put away")
      assert.equal(
        (findText("[data-slot=button]", "staging") as HTMLButtonElement).disabled,
        true,
        "and cannot be answered again",
      )
    },
  )
})

test("a card opened on a later page lands on it, rather than scrolling up from the first", async () => {
  // A host asks a call's questions one prompt at a time and the card is drawn again for each: an
  // animated scroll from the first page reads every page it passes, and the count flashes back.
  const scrolls: ScrollBehavior[] = []
  const width = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "clientWidth")
  const scrollTo = HTMLElement.prototype.scrollTo
  Object.defineProperty(HTMLElement.prototype, "clientWidth", {
    configurable: true,
    get: () => 320,
  })
  HTMLElement.prototype.scrollTo = function (
    this: HTMLElement,
    options?: ScrollToOptions | number,
  ) {
    const given = typeof options === "object" ? options : {}
    scrolls.push(given.behavior ?? "auto")
    this.scrollLeft = Number(given.left ?? 0)
    this.dispatchEvent(new Event("scroll"))
  } as typeof HTMLElement.prototype.scrollTo
  try {
    const ask = [
      { id: "q0", question: "Which environment?", choices: ["staging", "production"] },
      { id: "q1", question: "Which services?", choices: ["api", "worker"] },
      { id: "q2", question: "Who reviews it?", choices: ["Platform", "Product"] },
    ]
    await mount(
      <QuestionCard message={message(ask)} askedId="q2" onAnswer={async () => {}} />,
      async () => {
        await settle()
        assert.ok(scrolls.length > 0, "the row is moved to the asked page")
        assert.notEqual(scrolls[0], "smooth", "the first move is a landing, not an animation")
        assert.match(text(), /3 of 3/)
      },
    )
  } finally {
    if (width) Object.defineProperty(HTMLElement.prototype, "clientWidth", width)
    HTMLElement.prototype.scrollTo = scrollTo
  }
})

test("a card the host moves to its next question reads only that page, not the pages it slides past", async () => {
  // One card is kept across a call's prompts, so the next question slides in: a slide's scroll
  // passes the page it left, and a count read off that would flash back before it lands.
  const width = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "clientWidth")
  const scrollTo = HTMLElement.prototype.scrollTo
  Object.defineProperty(HTMLElement.prototype, "clientWidth", {
    configurable: true,
    get: () => 320,
  })
  HTMLElement.prototype.scrollTo = function (
    this: HTMLElement,
    options?: ScrollToOptions | number,
  ) {
    const given = typeof options === "object" ? options : {}
    const target = Number(given.left ?? 0)
    if (given.behavior !== "smooth") {
      this.scrollLeft = target
      this.dispatchEvent(new Event("scroll"))
      return
    }
    // A slide: a frame still at the page it left, then the page it lands on.
    this.dispatchEvent(new Event("scroll"))
    setTimeout(() => {
      this.scrollLeft = target
      this.dispatchEvent(new Event("scroll"))
    }, 40)
  } as typeof HTMLElement.prototype.scrollTo
  const ask = [
    { id: "q0", question: "Which environment?", choices: ["staging", "production"] },
    { id: "q1", question: "Which services?", choices: ["api", "worker"] },
    { id: "q2", question: "Who reviews it?", choices: ["Platform", "Product"] },
  ]
  let moveTo: (id: string) => void = () => {}
  function Host() {
    const [asked, setAsked] = useState("q0")
    useEffect(() => {
      moveTo = setAsked
    }, [])
    return <QuestionCard message={message(ask)} askedId={asked} onAnswer={async () => {}} />
  }
  try {
    await mount(<Host />, async () => {
      await settle()
      assert.match(text(), /1 of 3/)
      const counts: string[] = []
      const observer = new MutationObserver(() => {
        const count = text().match(/\d of 3/)?.[0]
        if (count && counts.at(-1) !== count) counts.push(count)
      })
      observer.observe(document.body, { subtree: true, childList: true, characterData: true })
      await act(async () => moveTo("q1"))
      await new Promise((done) => setTimeout(done, 120))
      await settle()
      observer.disconnect()
      assert.deepEqual(counts, ["2 of 3"], "the count goes straight to the asked page")
    })
  } finally {
    if (width) Object.defineProperty(HTMLElement.prototype, "clientWidth", width)
    HTMLElement.prototype.scrollTo = scrollTo
  }
})

import { useEffect, useLayoutEffect, useRef, useState } from "react"
import {
  CheckIcon,
  ChevronLeftIcon,
  ChevronRightIcon,
  MessageCircleQuestionIcon,
} from "lucide-react"

import { Refusal } from "@/components/banner"
import { CARD } from "@/components/chat/session-cards"
import { useCodeFace } from "@/components/chat/code-face"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardFooter, CardHeader, CardTitle } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { Textarea } from "@/components/ui/textarea"
import { answerClarify } from "@/lib/chat"
import {
  answerOf,
  NOTHING_PICKED,
  type Picked,
  type PickedForm,
  type TakenForm,
} from "@/lib/clarify-form"
import { prefersReducedMotion } from "@/lib/media"
import type { ClarifyAnswers, ClarifyQuestion, Message } from "@/lib/db"
import { useRefusal } from "@/lib/use-refusal"
import { cn } from "@/lib/utils"

const OTHER = "\u0000other"

export function ChoiceRow({
  label,
  selected,
  recommended,
  disabled,
  onClick,
}: {
  label: string
  selected: boolean
  recommended?: boolean
  disabled: boolean
  onClick: () => void
}) {
  // A choice is the bot's words, so a session says them in its own face; the badge beside it is the
  // app's and keeps the app's (ADR 0087).
  const face = useCodeFace()
  return (
    <Button
      type="button"
      variant="outline"
      size="lg"
      aria-pressed={selected}
      disabled={disabled}
      onClick={onClick}
      className={cn(
        "h-auto min-h-11 w-full justify-start gap-3 rounded-2xl px-4 py-2.5 text-left text-[15px] font-normal whitespace-normal",
        selected && "border-primary bg-primary/10 hover:bg-primary/15",
      )}
    >
      <span
        className={cn(
          "flex size-5 shrink-0 items-center justify-center rounded-full border",
          selected ? "border-primary bg-primary text-primary-foreground" : "border-border",
        )}
      >
        {selected && <CheckIcon className="size-3.5" />}
      </span>
      <span className={cn("min-w-0 flex-1 wrap-anywhere", face)}>{label}</span>
      {recommended && (
        <Badge variant="secondary" className="shrink-0">
          Recommended
        </Badge>
      )}
    </Button>
  )
}

function Question({
  question,
  picked,
  disabled,
  onChange,
}: {
  question: ClarifyQuestion
  picked: Picked
  disabled: boolean
  onChange: (picked: Picked) => void
}) {
  const choices = question.choices
  const pick = (choice: string) => {
    if (choice === OTHER) {
      onChange({
        ...picked,
        usingOther: !picked.usingOther,
        choices: question.multiSelect ? picked.choices : [],
      })
      return
    }
    if (question.multiSelect) {
      const has = picked.choices.includes(choice)
      onChange({
        ...picked,
        choices: has ? picked.choices.filter((c) => c !== choice) : [...picked.choices, choice],
      })
    } else {
      onChange({
        ...picked,
        choices: picked.choices[0] === choice ? [] : [choice],
        usingOther: false,
      })
    }
  }
  const face = useCodeFace()
  return (
    <div className="space-y-2">
      <p className={cn("text-[15px] font-medium", face)}>{question.question}</p>
      {choices ? (
        <div className="space-y-1.5">
          {choices.map((choice, i) => (
            <ChoiceRow
              key={choice}
              label={choice}
              selected={picked.choices.includes(choice)}
              recommended={i === 0 && choices.length > 1}
              disabled={disabled}
              onClick={() => pick(choice)}
            />
          ))}
          <ChoiceRow
            label="Other"
            selected={picked.usingOther}
            disabled={disabled}
            onClick={() => pick(OTHER)}
          />
          {picked.usingOther && (
            <Input
              autoFocus
              value={picked.other}
              disabled={disabled}
              placeholder="Type your answer"
              className={cn("h-11 rounded-2xl", face)}
              onChange={(e) => onChange({ ...picked, other: e.target.value })}
            />
          )}
        </div>
      ) : (
        <Textarea
          value={picked.other}
          disabled={disabled}
          placeholder="Type your answer"
          className={cn("min-h-20 rounded-2xl", face)}
          onChange={(e) => onChange({ ...picked, other: e.target.value })}
        />
      )}
    </div>
  )
}

const motion = () => (prefersReducedMotion() ? "auto" : "smooth")

/**
 * The most the card may take from a screen, whatever a question asks: half of it, so the thread it
 * was asked over and the reader's own work stay in view, and a long question scrolls inside it
 * rather than pushing its own buttons past the edge.
 */
const HALF_SCREEN = "max-h-[50dvh]"

/**
 * The agent's questions, in place of the composer until answered; the answers then show as a card
 * in the thread (`ClarifyCard`). One question is a plain form. Two or more are pages of one card
 * (swipe, or the arrows beside its count), and any question may be skipped — so a question longer
 * than the screen never takes the card's own buttons off it.
 *
 * `askedId` is what a host that asks one prompt at a time needs (Hermes's own route): the question
 * the host waits on, of every question the agent put in one call. The card is still one form — Next
 * until the last page, Send there — and opens on the asked question, whose pages before it the host
 * has already taken. Sending commits the form: the card answers the asked question, then each one
 * the host asks after it, with no tap, never while `held`. A refusal ends that and leaves the form
 * filled on the asked page.
 */
export function QuestionCard({
  message,
  askedId,
  from,
  held = false,
  taken,
  onTaken,
  onAnswer = (answers) => answerClarify(message, answers),
}: {
  message: Message
  /** The question the host waits on; absent where the call's questions are answered at once. */
  askedId?: string
  /** Who asks — a room's member — where the screen drawing the card knows and a chat's row doesn't. */
  from?: string
  /** The question shown is answered and the host has yet to ask the next: nothing can be sent. */
  held?: boolean
  /** The form this card took for the call before it was drawn again, with the prompt it last answered. */
  taken?: TakenForm
  /** Where the form taken goes, so a card drawn again answers the rest from it; undefined on a refusal. */
  onTaken?: (taken: TakenForm | undefined) => void
  /** Where the answers go; the chat's own engine unless the screen drawing the card answers itself. */
  onAnswer?: (answers: ClarifyAnswers) => Promise<void>
}) {
  const { questions } = message.clarify!
  const paged = questions.length > 1
  const askedPage = askedId ? questions.findIndex((one) => one.id === askedId) : -1
  const oneAtATime = askedPage >= 0
  const [sending, setPending] = useState(false)
  const refusal = useRefusal()
  // The form as sent, still owed to a host that asks one question at a time — taken up again where
  // this card is the call's card drawn a second time, since a host that outlasts the card's hold has
  // the reader's answers go with the first one otherwise. A lone question has no second prompt to
  // owe, and takes no form up (nothing ever draws it again).
  const owed = oneAtATime && paged ? taken : undefined
  const [committed, setCommitted] = useState<PickedForm | null>(owed?.form ?? null)
  /** The asked question the committed form last answered, so no question is answered twice. */
  const sentFor = useRef<string>(owed?.answeredPrompt)
  const pending = sending || held || committed !== null
  const [page, setPage] = useState(oneAtATime ? askedPage : 0)
  const card = useRef<HTMLDivElement>(null)
  const head = useRef<HTMLDivElement>(null)
  const foot = useRef<HTMLDivElement>(null)
  const row = useRef<HTMLDivElement>(null)
  /** The page a slide the card started is headed for, until the row lands on it. */
  const steering = useRef<number | null>(null)
  const pages = useRef<(HTMLDivElement | null)[]>([])
  // The row is as tall as the page showing, so a short question leaves no gap above the buttons.
  const [height, setHeight] = useState<number>()
  // A question read in after the prompt named another has nothing picked yet: an empty form. One the
  // form was already filled in for opens with the answers it gave, as the reader left them.
  const [picked, setPicked] = useState<PickedForm>(() => owed?.form ?? {})
  const pickOf = (id: string): Picked => picked[id] ?? NOTHING_PICKED
  const answers: ClarifyAnswers = Object.fromEntries(
    questions.map((q) => [q.id, answerOf(q, pickOf(q.id))]),
  )
  const last = page === questions.length - 1

  // The row scrolls (a swipe, or the buttons below), so the page is read back from where it rests.
  useEffect(() => {
    const el = row.current
    if (!el) return
    let frame = 0
    const read = () => {
      frame = 0
      if (!el.clientWidth) return
      const at = Math.round(el.scrollLeft / el.clientWidth)
      // A slide the card started passes the pages between: the count waits for where it lands.
      if (steering.current !== null) {
        if (at !== steering.current) return
        steering.current = null
      }
      setPage(at)
    }
    const onScroll = () => {
      if (!frame) frame = requestAnimationFrame(read)
    }
    // The reader taking the row ends a slide the card started: the count follows them.
    const taken = () => {
      steering.current = null
    }
    el.addEventListener("scroll", onScroll, { passive: true })
    for (const kind of ["pointerdown", "touchstart", "wheel"]) {
      el.addEventListener(kind, taken, { passive: true })
    }
    return () => {
      el.removeEventListener("scroll", onScroll)
      for (const kind of ["pointerdown", "touchstart", "wheel"]) el.removeEventListener(kind, taken)
      cancelAnimationFrame(frame)
    }
  }, [paged])

  useLayoutEffect(() => {
    if (!paged) return
    const pageEl = pages.current[page]
    const cardEl = card.current
    if (!pageEl || !cardEl) return
    const measure = () => {
      // The page's own content height, which a capped page still reports as its scroll extent.
      const wants = pageEl.scrollHeight
      const style = getComputedStyle(cardEl)
      // What the card has left for a page once its header, footer, padding and gaps are paid for.
      // The cap is the card's own resolved max-height, never its current height: a row measured
      // against a card that had already shrunk would clip the page it was sizing.
      const cap = parseFloat(style.maxHeight) || window.innerHeight / 2
      const room =
        cap -
        (head.current?.offsetHeight ?? 0) -
        (foot.current?.offsetHeight ?? 0) -
        (parseFloat(style.paddingTop) || 0) -
        (parseFloat(style.paddingBottom) || 0) -
        2 * (parseFloat(style.rowGap) || 0)
      if (!wants || room <= 0) return
      setHeight(Math.min(wants, Math.floor(room)))
    }
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(pageEl)
    observer.observe(cardEl)
    return () => observer.disconnect()
  }, [page, paged])

  const goTo = (index: number, behavior: ScrollBehavior = motion()) => {
    steering.current = index
    row.current?.scrollTo({ left: index * row.current.clientWidth, behavior })
  }

  // Turns with the host, without taking the arrows away between its turns.
  const [turnedTo, setTurnedTo] = useState(askedPage)
  if (oneAtATime && turnedTo !== askedPage) {
    setTurnedTo(askedPage)
    setPage(askedPage)
  }
  // A host that asks one prompt at a time has the card drawn again for each: it lands on the asked
  // page before it is painted, since an animated scroll from the first would read every page it
  // passes and the count would flash back. Later turns within one card still slide.
  const landed = useRef(false)
  useLayoutEffect(() => {
    if (!oneAtATime) return
    goTo(askedPage, landed.current ? motion() : "instant")
    landed.current = true
  }, [oneAtATime, askedPage])

  // Leaves this question unanswered (a skipped question is null to Hermes) and moves on.
  const current = questions[page]
  const skip = () => {
    setPicked((all) => ({ ...all, [current.id]: NOTHING_PICKED }))
    if (last) commit({ ...picked, [current.id]: NOTHING_PICKED })
    else goTo(page + 1)
  }

  const send = async (given: ClarifyAnswers) => {
    setPending(true)
    try {
      return await refusal.write("send your answer", () => onAnswer(given))
    } finally {
      setPending(false)
    }
  }

  // Lets the form go: the card comes back to the reader, on the page the host asks.
  const release = () => {
    setCommitted(null)
    // The reader gives this one again: the question is theirs while the card stays on it.
    sentFor.current = undefined
    onTaken?.(undefined)
    goTo(askedPage)
  }

  // A host asking one at a time takes only the question it asks; the rest wait in the commit. One
  // answer per prompt: a card drawn again while an answer was still going must not send it twice.
  const answerAsked = async (form: PickedForm) => {
    if (!askedId || sentFor.current === askedId) return
    const question = questions.find((one) => one.id === askedId)
    if (!question) return release()
    sentFor.current = askedId
    onTaken?.({ form, answeredPrompt: askedId })
    if (await send({ [askedId]: answerOf(question, form[askedId] ?? NOTHING_PICKED) })) return
    release()
  }

  const commit = (form: PickedForm) => {
    if (!oneAtATime)
      return void send(
        Object.fromEntries(questions.map((one) => [one.id, answerOf(one, form[one.id] ?? NOTHING_PICKED)])),
      )
    setCommitted(form)
    void answerAsked(form)
  }

  // The host asks the next question of the call a moment after the last answer: it is answered from
  // the commit, since the reader already gave it. A question the form has no page for is the
  // reader's own to give — a call whose ask was read differently is never skipped in their name.
  useEffect(() => {
    if (!committed || !askedId || held || sending || !oneAtATime) return
    if (sentFor.current === askedId) return
    if (!(askedId in committed)) return release()
    void answerAsked(committed)
  })

  const onChange = (id: string) => (next: Picked) => setPicked((all) => ({ ...all, [id]: next }))

  return (
    <Card ref={card} size="sm" className={cn(CARD, HALF_SCREEN)}>
      <CardHeader ref={head} className="shrink-0">
        <CardTitle className="flex items-center gap-2 text-base text-primary">
          <MessageCircleQuestionIcon className="size-5 shrink-0" />
          {paged ? "Questions" : "Question"}
          {from && <span className="text-sm font-normal text-muted-foreground">{from}</span>}
          {paged && (
            <div className="ml-auto flex items-center gap-1">
              <span
                aria-live="polite"
                className="px-1 text-sm font-normal text-muted-foreground tabular-nums"
              >
                {page + 1} of {questions.length}
              </span>
              <Button
                type="button"
                variant="ghost"
                size="icon-sm"
                aria-label="Previous question"
                disabled={pending || page === 0}
                onClick={() => goTo(page - 1)}
              >
                <ChevronLeftIcon />
              </Button>
              <Button
                type="button"
                variant="ghost"
                size="icon-sm"
                aria-label="Next question"
                disabled={pending || last}
                onClick={() => goTo(page + 1)}
              >
                <ChevronRightIcon />
              </Button>
            </div>
          )}
        </CardTitle>
      </CardHeader>
      {paged ? (
        <CardContent className="min-h-0 overflow-hidden">
          <div
            ref={row}
            data-question-pages
            style={{ height }}
            className="-m-1 flex snap-x snap-mandatory [scrollbar-width:none] items-start overflow-x-auto overscroll-x-contain transition-[height] motion-reduce:transition-none [&::-webkit-scrollbar]:hidden"
          >
            {questions.map((question, i) => (
              <div
                key={question.id}
                ref={(el) => {
                  pages.current[i] = el
                }}
                data-question-page={i}
                style={{ maxHeight: height }}
                role="group"
                aria-roledescription="slide"
                aria-label={`Question ${i + 1} of ${questions.length}`}
                inert={i !== page}
                className="w-full shrink-0 snap-center snap-always overflow-y-auto overscroll-contain p-1"
              >
                <Question
                  question={question}
                  picked={pickOf(question.id)}
                  disabled={pending || (oneAtATime && i < askedPage)}
                  onChange={onChange(question.id)}
                />
              </div>
            ))}
          </div>
        </CardContent>
      ) : (
        <CardContent className="min-h-0 overflow-y-auto overscroll-contain">
          <Question
            question={questions[0]}
            picked={pickOf(questions[0].id)}
            disabled={pending}
            onChange={onChange(questions[0].id)}
          />
        </CardContent>
      )}
      <Refusal hold={refusal} className="mx-(--card-spacing)" />
      <CardFooter ref={foot} className="shrink-0 gap-2">
        <Button
          type="button"
          variant="outline"
          size="lg"
          className="h-11 flex-1 sm:min-w-28 sm:flex-none"
          disabled={pending}
          onClick={skip}
        >
          Skip
        </Button>
        {paged && !last ? (
          <Button
            type="button"
            size="lg"
            className="h-11 flex-1 sm:min-w-40 sm:flex-none"
            disabled={pending || !answers[current.id]}
            onClick={() => goTo(page + 1)}
          >
            Next
          </Button>
        ) : (
          <Button
            size="lg"
            className="h-11 flex-1 sm:min-w-40 sm:flex-none"
            disabled={pending || !answers[current.id]}
            onClick={() => commit(picked)}
          >
            Send
          </Button>
        )}
      </CardFooter>
    </Card>
  )
}

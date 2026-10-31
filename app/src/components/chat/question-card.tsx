import { useEffect, useLayoutEffect, useRef, useState } from "react"
import {
  CheckIcon,
  ChevronLeftIcon,
  ChevronRightIcon,
  MessageCircleQuestionIcon,
} from "lucide-react"
import { toast } from "sonner"

import { CARD } from "@/components/chat/session-cards"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardFooter, CardHeader, CardTitle } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { Textarea } from "@/components/ui/textarea"
import { answerClarify } from "@/lib/chat"
import { prefersReducedMotion } from "@/lib/media"
import type { ClarifyAnswers, ClarifyQuestion, Message } from "@/lib/db"
import { cn } from "@/lib/utils"

const OTHER = "\u0000other"

/** What the user has picked or typed for one question, before it's sent. */
interface Picked {
  choices: string[]
  other: string
  usingOther: boolean
}

function answerOf(question: ClarifyQuestion, picked: Picked): string | string[] | null {
  const typed = picked.other.trim()
  if (!question.choices) return typed || null
  if (question.multiSelect) {
    const all = [...picked.choices, ...(picked.usingOther && typed ? [typed] : [])]
    return all.length ? all : null
  }
  if (picked.usingOther) return typed || null
  return picked.choices[0] ?? null
}

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
      <span className="min-w-0 flex-1 wrap-anywhere">{label}</span>
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
  return (
    <div className="space-y-2">
      <p className="text-[15px] font-medium">{question.question}</p>
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
              className="h-11 rounded-2xl"
              onChange={(e) => onChange({ ...picked, other: e.target.value })}
            />
          )}
        </div>
      ) : (
        <Textarea
          value={picked.other}
          disabled={disabled}
          placeholder="Type your answer"
          className="min-h-20 rounded-2xl"
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
 */
export function QuestionCard({
  message,
  onAnswer = (answers) => answerClarify(message, answers),
}: {
  message: Message
  /** Where the answers go; the chat's own engine unless the screen drawing the card answers itself. */
  onAnswer?: (answers: ClarifyAnswers) => Promise<void>
}) {
  const { questions } = message.clarify!
  const paged = questions.length > 1
  const [pending, setPending] = useState(false)
  const [page, setPage] = useState(0)
  const card = useRef<HTMLDivElement>(null)
  const head = useRef<HTMLDivElement>(null)
  const foot = useRef<HTMLDivElement>(null)
  const row = useRef<HTMLDivElement>(null)
  const pages = useRef<(HTMLDivElement | null)[]>([])
  // The row is as tall as the page showing, so a short question leaves no gap above the buttons.
  const [height, setHeight] = useState<number>()
  const [picked, setPicked] = useState<Record<string, Picked>>(() =>
    Object.fromEntries(questions.map((q) => [q.id, { choices: [], other: "", usingOther: false }])),
  )
  const answers: ClarifyAnswers = Object.fromEntries(
    questions.map((q) => [q.id, answerOf(q, picked[q.id])]),
  )
  const anything = Object.values(answers).some(Boolean)
  const last = page === questions.length - 1

  // The row scrolls (a swipe, or the buttons below), so the page is read back from where it rests.
  useEffect(() => {
    const el = row.current
    if (!el) return
    let frame = 0
    const read = () => {
      frame = 0
      if (el.clientWidth) setPage(Math.round(el.scrollLeft / el.clientWidth))
    }
    const onScroll = () => {
      if (!frame) frame = requestAnimationFrame(read)
    }
    el.addEventListener("scroll", onScroll, { passive: true })
    return () => {
      el.removeEventListener("scroll", onScroll)
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

  const goTo = (index: number) => {
    const el = row.current
    if (el) el.scrollTo({ left: index * el.clientWidth, behavior: motion() })
  }

  // Leaves this question unanswered (a skipped question is null to Hermes) and moves on.
  const current = questions[page]
  const skip = () => {
    setPicked((all) => ({ ...all, [current.id]: { choices: [], other: "", usingOther: false } }))
    if (last) void send({ ...answers, [current.id]: null })
    else goTo(page + 1)
  }

  const send = async (given: ClarifyAnswers = answers) => {
    setPending(true)
    try {
      await onAnswer(given)
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Couldn't send your answer.")
    } finally {
      setPending(false)
    }
  }

  const onChange = (id: string) => (next: Picked) => setPicked((all) => ({ ...all, [id]: next }))

  return (
    <Card ref={card} size="sm" className={cn(CARD, HALF_SCREEN)}>
      <CardHeader ref={head} className="shrink-0">
        <CardTitle className="flex items-center gap-2 text-base text-primary">
          <MessageCircleQuestionIcon className="size-5 shrink-0" />
          {paged ? "Questions" : "Question"}
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
                  picked={picked[question.id]}
                  disabled={pending}
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
            picked={picked[questions[0].id]}
            disabled={pending}
            onChange={onChange(questions[0].id)}
          />
        </CardContent>
      )}
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
            disabled={!answers[current.id]}
            onClick={() => goTo(page + 1)}
          >
            Next
          </Button>
        ) : (
          <Button
            size="lg"
            className="h-11 flex-1 sm:min-w-40 sm:flex-none"
            disabled={pending || (paged ? !answers[current.id] : !anything)}
            onClick={() => void send()}
          >
            Send
          </Button>
        )}
      </CardFooter>
    </Card>
  )
}

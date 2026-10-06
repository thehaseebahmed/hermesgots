import { useEffect, useRef, useState } from "react"
import { CheckIcon, MessageCircleQuestionIcon } from "lucide-react"
import { toast } from "sonner"

import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardFooter, CardHeader, CardTitle } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { Textarea } from "@/components/ui/textarea"
import { answerClarify } from "@/lib/chat"
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

function ChoiceRow({
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

const motion = () =>
  window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth"

/** One step marker: filled once its question has an answer, long while it's the one showing. */
function Dot({
  index,
  current,
  answered,
  onClick,
}: {
  index: number
  current: boolean
  answered: boolean
  onClick: () => void
}) {
  return (
    <button
      type="button"
      aria-label={`Question ${index + 1}${answered ? ", answered" : ""}`}
      aria-current={current ? "step" : undefined}
      onClick={onClick}
      className="flex size-11 items-center justify-center rounded-full outline-none focus-visible:ring-3 focus-visible:ring-ring/50"
    >
      <span
        className={cn(
          "h-2.5 rounded-full border border-primary transition-[width,background-color] motion-reduce:transition-none",
          current ? "w-6" : "w-2.5",
          answered ? "bg-primary" : "bg-transparent",
        )}
      />
    </button>
  )
}

/**
 * The agent's questions, in place of the composer until answered; the answers then show as a card
 * in the thread (`ClarifyCard`). One question is a plain form. Two or more are pages of one card
 * (swipe, tap a dot, or Back and Next), so five questions never outgrow the screen.
 */
export function QuestionCard({ message }: { message: Message }) {
  const { questions } = message.clarify!
  const paged = questions.length > 1
  const [pending, setPending] = useState(false)
  const [page, setPage] = useState(0)
  const row = useRef<HTMLDivElement>(null)
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

  const goTo = (index: number) => {
    const el = row.current
    if (el) el.scrollTo({ left: index * el.clientWidth, behavior: motion() })
  }

  const send = async () => {
    setPending(true)
    try {
      await answerClarify(message, answers)
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Couldn't send your answer.")
    } finally {
      setPending(false)
    }
  }

  const onChange = (id: string) => (next: Picked) => setPicked((all) => ({ ...all, [id]: next }))

  return (
    <Card
      size="sm"
      className="w-full rounded-3xl border shadow-xl ring-0 shadow-black/10 dark:shadow-black/40"
    >
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base text-primary">
          <MessageCircleQuestionIcon className="size-5" />
          {paged ? "Questions" : "Question"}
          {paged && (
            <span
              aria-live="polite"
              className="ml-auto text-sm font-normal text-muted-foreground tabular-nums"
            >
              {page + 1} of {questions.length}
            </span>
          )}
        </CardTitle>
      </CardHeader>
      {paged ? (
        <CardContent className="space-y-1">
          <div className="-mt-2 flex justify-center">
            {questions.map((question, i) => (
              <Dot
                key={question.id}
                index={i}
                current={i === page}
                answered={Boolean(answers[question.id])}
                onClick={() => goTo(i)}
              />
            ))}
          </div>
          {/* The row is as tall as its tallest page, so the card holds one height while paging. */}
          <div
            ref={row}
            className="-m-1 flex snap-x snap-mandatory [scrollbar-width:none] overflow-x-auto overscroll-x-contain [&::-webkit-scrollbar]:hidden"
          >
            {questions.map((question, i) => (
              <div
                key={question.id}
                role="group"
                aria-roledescription="slide"
                aria-label={`Question ${i + 1} of ${questions.length}`}
                inert={i !== page}
                className="max-h-[60dvh] w-full shrink-0 snap-center snap-always overflow-y-auto p-1"
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
        <CardContent>
          <Question
            question={questions[0]}
            picked={picked[questions[0].id]}
            disabled={pending}
            onChange={onChange(questions[0].id)}
          />
        </CardContent>
      )}
      <CardFooter className="gap-2">
        {paged && page > 0 && (
          <Button
            type="button"
            variant="outline"
            size="lg"
            className="h-11 flex-1 sm:min-w-28 sm:flex-none"
            disabled={pending}
            onClick={() => goTo(page - 1)}
          >
            Back
          </Button>
        )}
        {paged && !last ? (
          <Button
            type="button"
            size="lg"
            className="h-11 flex-1 sm:min-w-40 sm:flex-none"
            onClick={() => goTo(page + 1)}
          >
            Next
          </Button>
        ) : (
          <Button
            size="lg"
            className="h-11 flex-1 sm:min-w-40 sm:flex-none"
            disabled={pending || !anything}
            onClick={send}
          >
            Send
          </Button>
        )}
      </CardFooter>
    </Card>
  )
}

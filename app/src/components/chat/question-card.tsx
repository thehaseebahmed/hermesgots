import { useState } from "react"
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

/** The agent's questions, in place of the composer until answered. The answers then show as a card in the thread (`ClarifyCard`). */
export function QuestionCard({ message }: { message: Message }) {
  const { questions } = message.clarify!
  const [pending, setPending] = useState(false)
  const [picked, setPicked] = useState<Record<string, Picked>>(() =>
    Object.fromEntries(questions.map((q) => [q.id, { choices: [], other: "", usingOther: false }])),
  )
  const answers: ClarifyAnswers = Object.fromEntries(
    questions.map((q) => [q.id, answerOf(q, picked[q.id])]),
  )
  const anything = Object.values(answers).some(Boolean)

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

  return (
    <Card
      size="sm"
      className="w-full rounded-3xl border shadow-xl ring-0 shadow-black/10 dark:shadow-black/40"
    >
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base text-primary">
          <MessageCircleQuestionIcon className="size-5" />
          {questions.length > 1 ? "Questions" : "Question"}
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        {questions.map((question) => (
          <Question
            key={question.id}
            question={question}
            picked={picked[question.id]}
            disabled={pending}
            onChange={(next) => setPicked((all) => ({ ...all, [question.id]: next }))}
          />
        ))}
      </CardContent>
      <CardFooter>
        <Button
          size="lg"
          className="h-11 w-full sm:w-auto sm:min-w-40"
          disabled={pending || !anything}
          onClick={send}
        >
          Send
        </Button>
      </CardFooter>
    </Card>
  )
}

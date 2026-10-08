import { useState, type ReactNode } from "react"
import { LockIcon, SailboatIcon } from "lucide-react"

import { Popup, PopupContent, PopupDescription, PopupHeader, PopupTitle } from "@/components/popup"
import { Button } from "@/components/ui/button"
import { GATE_ICONS, GATES, markIntroSeen } from "@/lib/theseus"
import { cn } from "@/lib/utils"

const GATE_TEXT = {
  red: "The tests are written first and seen failing",
  tests: "Then the code makes them pass",
  visual: "Two blind reviewers compare each screen with the reference",
  review: "Independent reviewers, who see only the diff, find nothing",
  human: "You approve, as often as you choose",
}

const STEPS: { title: string; body: ReactNode }[] = [
  {
    title: "Meet Theseus",
    body: (
      <>
        <p>
          Theseus builds your change one small checkpoint at a time, and nothing moves on until the
          last checkpoint is proven.
        </p>
        <p className="text-muted-foreground">
          Long agent runs drift. Checking every small step catches a wrong turn while it's still
          cheap to fix.
        </p>
      </>
    ),
  },
  {
    title: "How each checkpoint is proven",
    body: (
      <ol className="flex flex-col gap-3">
        {GATES.map(({ id, label }) => {
          const Icon = GATE_ICONS[id]
          return (
            <li key={id} className="flex items-start gap-3">
              <span className="flex size-9 shrink-0 items-center justify-center rounded-full bg-primary/15 text-primary">
                <Icon className="size-4.5" />
              </span>
              <span className="min-w-0 flex-1">
                <span className="block font-medium">{label}</span>
                <span className="block text-sm text-muted-foreground">{GATE_TEXT[id]}</span>
              </span>
            </li>
          )
        })}
      </ol>
    ),
  },
  {
    title: "You decide, it does the rest",
    body: (
      <ol className="flex flex-col gap-3">
        {[
          "Answer its questions about the goal",
          "Confirm the plan",
          "Approve the checkpoints, and how often it should stop for you",
          "It works through them in Auto, even with the app closed",
        ].map((text, i) => (
          <li key={text} className="flex items-center gap-3">
            <span className="flex size-9 shrink-0 items-center justify-center rounded-full bg-muted font-medium tabular-nums">
              {i + 1}
            </span>
            <span className="min-w-0 flex-1">{text}</span>
          </li>
        ))}
      </ol>
    ),
  },
  {
    title: "One mode for the whole session",
    body: (
      <div className="flex items-start gap-3">
        <span className="flex size-9 shrink-0 items-center justify-center rounded-full bg-muted">
          <LockIcon className="size-4.5" />
        </span>
        <p className="min-w-0 flex-1">
          A Theseus session runs in Auto from start to finish. It can't switch to Plan, Accept edits
          or Auto later, so pick it when you start.
        </p>
      </div>
    ),
  },
]

/** Shown the first time Theseus is picked on this device: what it does and why, then Use Theseus. */
export function TheseusIntro({
  open,
  onOpenChange,
  onUse,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  onUse: () => void
}) {
  const [step, setStep] = useState(0)
  const last = step === STEPS.length - 1
  return (
    <Popup
      open={open}
      onOpenChange={(next) => {
        onOpenChange(next)
        if (!next) setStep(0)
      }}
    >
      <PopupContent>
        <PopupHeader className="items-center gap-3 pt-8 text-center">
          <span className="flex size-16 items-center justify-center rounded-full bg-primary/15 text-primary">
            <SailboatIcon className="size-8" />
          </span>
          <PopupTitle className="text-xl">{STEPS[step].title}</PopupTitle>
          <PopupDescription className="sr-only">
            Step {step + 1} of {STEPS.length}
          </PopupDescription>
        </PopupHeader>
        <div key={step} className="flex min-h-64 flex-col gap-3 px-6 pt-2 text-[15px] leading-6">
          {STEPS[step].body}
        </div>
        <div className="flex justify-center gap-1.5 pt-6" aria-hidden>
          {STEPS.map((_, i) => (
            <span
              key={i}
              className={cn(
                "h-1.5 rounded-full transition-all motion-reduce:transition-none",
                i === step ? "w-5 bg-primary" : "w-1.5 bg-muted-foreground/30",
              )}
            />
          ))}
        </div>
        <div className="flex gap-2 px-6 pt-6">
          <Button
            variant="outline"
            size="lg"
            className="h-11 flex-1"
            onClick={() => (step ? setStep(step - 1) : onOpenChange(false))}
          >
            {step ? "Back" : "Not now"}
          </Button>
          <Button
            size="lg"
            className="h-11 flex-1"
            onClick={() => {
              if (!last) return setStep(step + 1)
              markIntroSeen()
              onUse()
              onOpenChange(false)
              setStep(0)
            }}
          >
            {last ? "Use Theseus" : "Next"}
          </Button>
        </div>
      </PopupContent>
    </Popup>
  )
}

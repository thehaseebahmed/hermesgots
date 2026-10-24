import { MinusIcon, PlusIcon } from "lucide-react"
import { useEffect, useMemo, useState } from "react"
import { toast } from "sonner"

import { Button } from "@/components/ui/button"
import { Field, FieldGroup, FieldLabel } from "@/components/ui/field"
import { PICK_BUDGET } from "@/lib/afk-picks"
import type { Profile } from "@/lib/db"
import { READ_TIMEOUT_MS } from "@/lib/freshness"
import { getBotAfk, setBotAfkPickBudget } from "@/lib/hermes"

/**
 * The Coding tab: how a bot works when it is left alone, over every project it serves rather than
 * one of them. Its first control is the bot's pick budget (ADR 0042) — how many tasks it may hold at
 * once across its projects, one to ten, kept on its host through the bot-level `afk` route.
 *
 * The number shows what the host answered, never what was asked for: a write the host refuses
 * leaves the budget the tab already had, and a host that answers none reads as the default the host
 * would itself use.
 */
export function CodingTab({ profile }: { profile: Profile }) {
  // The profile is the host these numbers live on, so its own connection says which host answered:
  // an edited address or key asks the host it now names rather than showing the last one's budget.
  // Held still on those two parts — a profiles write makes a new object for the same host on every
  // keystroke, and this tab has one read to make, not one per write.
  const config = useMemo(
    () => ({ baseUrl: profile.baseUrl, apiKey: profile.apiKey }),
    [profile.baseUrl, profile.apiKey],
  )
  const [budget, setBudget] = useState<number | null>(null)
  const [failed, setFailed] = useState(false)
  // The count a write is carrying until its answer lands: a refused one drops it, so nothing on the
  // tab reads as saved that the host never kept.
  const [draft, setDraft] = useState<number | null>(null)
  const [saving, setSaving] = useState(false)

  // A host from before the route answers nothing, which is the reason the tab says it couldn't read
  // it rather than drawing a number nobody wrote.
  useEffect(() => {
    let cancelled = false
    setFailed(false)
    void getBotAfk(config, AbortSignal.timeout(READ_TIMEOUT_MS))
      .then((answer) => {
        if (cancelled) return
        setBudget(answer.pickBudget ?? PICK_BUDGET.unset)
      })
      .catch(() => {
        if (!cancelled) setFailed(true)
      })
    return () => {
      cancelled = true
    }
  }, [config])

  const shown = draft ?? budget ?? PICK_BUDGET.unset

  const choose = async (next: number) => {
    // The count the tab already holds is no write, and neither is one past the host's own range: the
    // stepper's buttons are out of reach there, so this is only the guard behind them.
    if (saving || failed || next < PICK_BUDGET.least || next > PICK_BUDGET.most || next === shown)
      return
    setDraft(next)
    setSaving(true)
    try {
      const answer = await setBotAfkPickBudget(config, next)
      setBudget(answer.pickBudget ?? next)
    } catch (failure) {
      toast.error(failure instanceof Error ? failure.message : "Couldn't save that pick budget.")
    } finally {
      setDraft(null)
      setSaving(false)
    }
  }

  return (
    <FieldGroup data-bot-coding>
      <Field aria-labelledby="pick-budget-label" aria-busy={saving || undefined}>
        <FieldLabel id="pick-budget-label">Pick budget</FieldLabel>
        <div className="flex items-center gap-3">
          <Button
            type="button"
            variant="outline"
            className="size-11"
            aria-label="Decrease pick budget"
            disabled={saving || failed || shown <= PICK_BUDGET.least}
            onClick={() => void choose(shown - 1)}
          >
            <MinusIcon />
          </Button>
          <span
            aria-live="polite"
            data-pick-budget={shown}
            className="min-w-8 text-center text-lg font-medium tabular-nums"
          >
            {shown}
          </span>
          <Button
            type="button"
            variant="outline"
            className="size-11"
            aria-label="Increase pick budget"
            disabled={saving || failed || shown >= PICK_BUDGET.most}
            onClick={() => void choose(shown + 1)}
          >
            <PlusIcon />
          </Button>
        </div>
        {failed && (
          <p className="text-sm text-muted-foreground">Couldn't read this bot's pick budget.</p>
        )}
      </Field>
    </FieldGroup>
  )
}

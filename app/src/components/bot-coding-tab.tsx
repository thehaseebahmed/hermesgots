import { MinusIcon, PlusIcon } from "lucide-react"
import { useEffect, useMemo, useState } from "react"
import { toast } from "sonner"

import { Segmented } from "@/components/segmented"
import { Group, rowClass } from "@/components/settings-chrome"
import { Button } from "@/components/ui/button"
import { PICK_BUDGET, USAGE_THRESHOLDS } from "@/lib/afk-picks"
import type { Profile } from "@/lib/db"
import { READ_TIMEOUT_MS } from "@/lib/freshness"
import {
  getBotAfk,
  getProviderUsage,
  setBotAfkPickBudget,
  setBotAfkUsageThreshold,
  type UsageWindow,
} from "@/lib/hermes"
import { modelInfoFor } from "@/lib/model-info"
import { noteFailure } from "@/lib/report"
import { cn } from "@/lib/utils"

/**
 * The Coding page: how a bot works when it is left alone, over every project it serves rather than
 * one of them. Its first control is the bot's pick budget (ADR 0042) — how many tasks it may hold at
 * once across its projects, one to ten, kept on its host through the bot-level `afk` route.
 *
 * The number shows what the host answered, never what was asked for: a write the host refuses
 * leaves the budget the tab already had, and a host that answers none reads as the default the host
 * would itself use. The one setting is a row: its title, what it counts, its value — with the
 * stepper beside it, since a stepper stays where it is rather than drilling in (ADR 0055).
 *
 * Under it sits the bot's usage threshold (ADR 0026): the share of its account already used at which
 * AFK stops picking tasks up, Off until it is set, as segments — Off then the whole tens from 50 to
 * 100, because that is one tap and not a form, and because turning the limit off is a choice of the
 * same control. Its value is the host's own answer after every write, like the budget's.
 *
 * While the account is at or over that number the row says which window decides and what it is at —
 * the window the pickup judged, as the usage route answers it, never a second copy of the rule — so
 * a hold-back is a figure the user can see coming rather than a session that failed for no stated
 * reason. Nothing is drawn beside the control while AFK can still pick up: Off, a window under the
 * threshold, or an account the host can't read.
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
  const [threshold, setThreshold] = useState<number | null>(null)
  const [failed, setFailed] = useState(false)
  // The count a write is carrying until its answer lands: a refused one drops it, so nothing on the
  // tab reads as saved that the host never kept.
  const [draft, setDraft] = useState<number | null>(null)
  const [thresholdDraft, setThresholdDraft] = useState<number | null>(null)
  const [saving, setSaving] = useState(false)
  // The window the host judged deciding, once it has answered: drawn only while it holds the bot
  // back, which is the fact the row exists for. The host's own window, kept whole, so a field it
  // gains later is here too.
  const [deciding, setDeciding] = useState<UsageWindow | null>(null)

  // A host from before the route answers nothing, which is the reason the tab says it couldn't read
  // it rather than drawing a number nobody wrote.
  useEffect(() => {
    let cancelled = false
    setFailed(false)
    void getBotAfk(config, AbortSignal.timeout(READ_TIMEOUT_MS))
      .then((answer) => {
        if (cancelled) return
        setBudget(answer.pickBudget ?? PICK_BUDGET.unset)
        setThreshold(answer.usageThreshold)
      })
      .catch(() => {
        if (!cancelled) setFailed(true)
      })
    return () => {
      cancelled = true
    }
  }, [config])

  const remembered = profile.hostModel?.provider
  const judging = threshold !== null
  // The bot's own main model — the account a pickup's first run would spend — read from the host
  // once this tab knows there is a threshold to judge it against. `modelInfoFor` rather than
  // `useModelInfo`, which is a screen's read: it remembers the model on the bot's own record and so
  // moves the bot's clock, and opening a settings tab is no claim that the bot changed.
  const [hostProvider, setHostProvider] = useState<string | undefined>(undefined)
  useEffect(() => {
    if (!judging) return
    let cancelled = false
    void modelInfoFor(config).then((info) => {
      if (!cancelled) setHostProvider(info?.provider)
    })
    return () => {
      cancelled = true
    }
  }, [config, judging])

  // The provider is the host's answer where it gave one and this device's copy of it where it
  // didn't. A host with no usage route, a provider that can't be read and an answer with no windows
  // all leave the row silent rather than guessing (ADR 0026, ADR 0007).
  const provider = hostProvider ?? remembered
  useEffect(() => {
    if (!judging || !provider) return
    let cancelled = false
    void getProviderUsage(config, provider, AbortSignal.timeout(READ_TIMEOUT_MS))
      .then((usage) => {
        if (cancelled) return
        setDeciding(usage?.deciding ?? null)
      })
      .catch((error) => {
        noteFailure("Reading the account's usage", error)
        if (!cancelled) setDeciding(null)
      })
    return () => {
      cancelled = true
    }
  }, [config, judging, provider])

  const shown = draft ?? budget ?? PICK_BUDGET.unset
  const thresholdShown = thresholdDraft ?? threshold
  const holdingBack =
    deciding && thresholdShown !== null && deciding.usedPercent >= thresholdShown ? deciding : null

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

  const chooseThreshold = async (next: number | null) => {
    // The value the tab already holds is no write, and a write still in flight is not one to race.
    if (saving || failed || next === thresholdShown) return
    setThresholdDraft(next)
    setSaving(true)
    try {
      const answer = await setBotAfkUsageThreshold(config, next)
      setThreshold(answer.usageThreshold)
      // Off draws no figure, and the window behind it is no longer this bot's to show: the next
      // threshold set reads the account again.
      if ((answer.usageThreshold ?? null) === null) setDeciding(null)
    } catch (failure) {
      toast.error(
        failure instanceof Error ? failure.message : "Couldn't save that usage threshold.",
      )
    } finally {
      setThresholdDraft(null)
      setSaving(false)
    }
  }

  return (
    <div className="flex flex-col gap-4" data-bot-coding>
      <Group>
        <div className={cn(rowClass, "items-start gap-3")} aria-busy={saving || undefined}>
          <div className="flex min-w-0 flex-1 flex-col gap-0.5 py-0.5">
            <span id="pick-budget-label" className="text-base">
              Pick budget
            </span>
            <span className="text-sm text-muted-foreground">
              How many tasks one bot's AFK may hold at once across all of its projects
            </span>
            <span aria-live="polite" data-pick-budget={shown} className="text-sm text-primary">
              {shown} {shown === 1 ? "task" : "tasks"}
            </span>
          </div>
          <div className="flex shrink-0 items-center gap-2">
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
        </div>
        {failed && (
          <p className={cn(rowClass, "text-sm text-muted-foreground")}>
            Couldn't read this bot's pick budget.
          </p>
        )}
      </Group>
      <Group>
        <div className="flex flex-col gap-3 px-4 py-3" aria-busy={saving || undefined}>
          <div className="flex min-w-0 flex-col gap-0.5">
            <span id="usage-threshold-label" className="text-base">
              Usage threshold
            </span>
            <span className="text-sm text-muted-foreground">
              Stop picking tasks up once this much of the bot's account is used
            </span>
            <span
              aria-live="polite"
              data-usage-threshold={thresholdShown ?? "off"}
              className="text-sm text-primary"
            >
              {thresholdShown === null ? "Off" : `${thresholdShown}% used`}
            </span>
          </div>
          <Segmented
            label="Usage threshold"
            compact
            options={USAGE_THRESHOLDS.map((each) => ({
              id: each,
              label: each === null ? "Off" : String(each),
            }))}
            value={thresholdShown}
            onChange={(next) => void chooseThreshold(next)}
            disabled={saving || failed}
          />
          {holdingBack && (
            <p data-usage-window={holdingBack.label} className="text-sm text-muted-foreground">
              {holdingBack.label || "Usage"} is at {holdingBack.usedPercent}% used, at or above this
              bot's {thresholdShown}% threshold.
            </p>
          )}
        </div>
      </Group>
    </div>
  )
}

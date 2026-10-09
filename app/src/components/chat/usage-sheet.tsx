import { Meter } from "@base-ui/react/meter"

import { Banner } from "@/components/banner"
import { Popup, PopupContent, PopupHeader, PopupTitle } from "@/components/popup"
import { formatTokens } from "@/lib/format"
import { useModelsDevUnreachable } from "@/lib/models"

export interface ContextUsage {
  /** The bot's server has the Memento plugin, which is what records context use. */
  tracked: boolean
  /** Prompt tokens of the session's latest model call. */
  tokens?: number
  window?: number
}

function fraction({ tokens, window }: ContextUsage) {
  return tokens && window ? Math.min(1, tokens / window) : 0
}

/** A small fill ring for the chat's options menu, where it opens the usage sheet. */
export function ContextIcon({ usage }: { usage: ContextUsage }) {
  const filled = fraction(usage)
  const radius = 6.5
  const circumference = 2 * Math.PI * radius

  return (
    <svg viewBox="0 0 16 16" aria-hidden>
      <g transform="rotate(-90 8 8)">
        <circle cx="8" cy="8" r={radius} fill="none" strokeWidth="2" className="stroke-muted" />
        {filled > 0 && (
          <circle
            cx="8"
            cy="8"
            r={radius}
            fill="none"
            strokeWidth="2"
            strokeLinecap="round"
            strokeDasharray={circumference}
            strokeDashoffset={circumference * (1 - filled)}
            className={filled >= 0.9 ? "stroke-destructive" : "stroke-primary"}
          />
        )}
      </g>
    </svg>
  )
}

/** How full the context is, e.g. "42%", or nothing while the window is unknown. */
export function ContextPercent({ usage }: { usage: ContextUsage }) {
  if (!usage.window) return null
  return (
    <span className="ml-auto text-muted-foreground tabular-nums">
      {Math.round(fraction(usage) * 100)}%
    </span>
  )
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="flex flex-col gap-2">
      <h3 className="px-1 text-sm text-muted-foreground">{title}</h3>
      <div className="flex flex-col gap-3 rounded-2xl bg-muted/60 p-4">{children}</div>
    </section>
  )
}

export function UsageSheet({
  open,
  onOpenChange,
  usage,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  usage: ContextUsage
}) {
  const unreachable = useModelsDevUnreachable()
  const filled = fraction(usage)

  return (
    <Popup side open={open} onOpenChange={onOpenChange}>
      <PopupContent>
        <PopupHeader className="items-center pb-2">
          <PopupTitle>Usage</PopupTitle>
        </PopupHeader>
        <div className="flex flex-col gap-6 px-6 text-[15px]">
          {!usage.tracked && <Banner>Context tracking needs the Memento plugin.</Banner>}
          <Section title="Context">
            {!usage.tracked || usage.window ? (
              <Meter.Root value={filled * 100} className="flex flex-col gap-2.5">
                <div className="flex items-baseline justify-between gap-4">
                  <Meter.Label className="font-medium">Context window</Meter.Label>
                  <span className="text-muted-foreground tabular-nums">
                    {usage.tokens || !usage.tracked
                      ? `${Math.round(filled * 100)}% used`
                      : "Not used yet"}
                  </span>
                </div>
                <Meter.Track className="h-2 overflow-hidden rounded-full bg-background">
                  <Meter.Indicator
                    className={
                      filled >= 0.9 ? "rounded-full bg-destructive" : "rounded-full bg-primary"
                    }
                  />
                </Meter.Track>
                <span className="text-sm text-muted-foreground tabular-nums">
                  {formatTokens(usage.tokens ?? 0)} of{" "}
                  {usage.window ? formatTokens(usage.window) : "—"} tokens
                </span>
              </Meter.Root>
            ) : (
              <p className="text-sm text-muted-foreground">
                {usage.tokens
                  ? `The last model call used ${formatTokens(usage.tokens)} prompt tokens. `
                  : ""}
                {unreachable
                  ? "Couldn't reach models.dev for this model's context size."
                  : "This model's context size isn't on models.dev."}
              </p>
            )}
          </Section>
        </div>
      </PopupContent>
    </Popup>
  )
}

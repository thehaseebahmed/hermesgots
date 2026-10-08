import { Meter } from "@base-ui/react/meter"

import { Banner } from "@/components/banner"
import { Popup, PopupContent, PopupHeader, PopupTitle } from "@/components/popup"
import { Button } from "@/components/ui/button"
import { formatTokens } from "@/lib/format"
import { useModelsDevUnreachable } from "@/lib/models"
import { useNav } from "@/lib/nav"

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

/** Fill ring for the composer, the size of the send button; opens the usage sheet. */
export function ContextRing({ usage, onClick }: { usage: ContextUsage; onClick: () => void }) {
  const filled = fraction(usage)
  const percent = Math.round(filled * 100)
  const radius = 20
  const circumference = 2 * Math.PI * radius
  const label = usage.window ? `Context ${percent}% used` : "Context usage"

  return (
    <Button
      type="button"
      variant="ghost"
      size="icon-lg"
      className="size-11 rounded-full text-muted-foreground"
      onClick={onClick}
      aria-label={label}
    >
      {/* Ring and label share one SVG so they share one centre. */}
      <svg viewBox="0 0 44 44" className="size-11" aria-hidden>
        <g transform="rotate(-90 22 22)">
          <circle cx="22" cy="22" r={radius} fill="none" strokeWidth="3" className="stroke-muted" />
          {filled > 0 && (
            <circle
              cx="22"
              cy="22"
              r={radius}
              fill="none"
              strokeWidth="3"
              strokeLinecap="round"
              strokeDasharray={circumference}
              strokeDashoffset={circumference * (1 - filled)}
              className={filled >= 0.9 ? "stroke-destructive" : "stroke-primary"}
            />
          )}
        </g>
        {usage.window && (
          <text
            x="22"
            y="22"
            textAnchor="middle"
            dominantBaseline="central"
            className="fill-current text-[11px] font-medium tabular-nums"
          >
            {percent}%
          </text>
        )}
      </svg>
    </Button>
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
  const { root } = useNav()
  const unreachable = useModelsDevUnreachable()
  const filled = fraction(usage)

  return (
    <Popup open={open} onOpenChange={onOpenChange}>
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
              <div className="flex flex-col items-start gap-3">
                <p className="text-sm text-muted-foreground">
                  {usage.tokens
                    ? `The last model call used ${formatTokens(usage.tokens)} prompt tokens. `
                    : ""}
                  {unreachable
                    ? "Couldn't reach models.dev for this model's context size."
                    : "This model's context size isn't on models.dev."}{" "}
                  Set it on this bot to see how full the chat is.
                </p>
                <Button
                  variant="outline"
                  className="min-h-11"
                  onClick={() => {
                    onOpenChange(false)
                    root("/settings/bots")
                  }}
                >
                  Set context window
                </Button>
              </div>
            )}
          </Section>
        </div>
      </PopupContent>
    </Popup>
  )
}

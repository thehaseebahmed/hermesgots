import { XIcon } from "lucide-react"
import { Meter } from "@base-ui/react/meter"

import { Banner } from "@/components/banner"
import { Button } from "@/components/ui/button"
import { Popup, PopupContent, PopupHeader, PopupTitle } from "@/components/popup"
import { formatTokens } from "@/lib/format"
import { useWide } from "@/lib/media"
import { useModelsDevUnreachable } from "@/lib/models"
import { useNow } from "@/lib/threads"
import {
  NOTICE_REMAINING_PERCENT,
  resetsAtText,
  resetsInText,
  windowViews,
  type UsageWindowView,
} from "@/lib/provider-usage"
import type { ProviderUsage } from "@/lib/hermes"

export interface ContextUsage {
  /** The bot's server has the Gots plugin, which is what records context use. */
  tracked: boolean
  /** Prompt tokens of the session's latest model call. */
  tokens?: number
  window?: number
  /** The model the window is for: the one the chat runs next, as `provider/model`. */
  model?: string
}

function fraction({ tokens, window }: ContextUsage) {
  return tokens && window ? Math.min(1, tokens / window) : 0
}

function contextPercent(usage: ContextUsage) {
  return usage.tracked && usage.window ? `${Math.round(fraction(usage) * 100)}%` : undefined
}

function ContextMeter({
  usage,
  size,
  percent,
}: {
  usage: ContextUsage
  size: 16 | 44
  percent?: string
}) {
  const filled = fraction(usage)
  const center = size / 2
  const radius = size === 16 ? 6.5 : 20.5
  const circumference = 2 * Math.PI * radius

  return (
    <svg
      viewBox={`0 0 ${size} ${size}`}
      className={size === 44 ? "size-11" : undefined}
      aria-hidden
    >
      <g transform={`rotate(-90 ${center} ${center})`}>
        <circle
          cx={center}
          cy={center}
          r={radius}
          fill="none"
          strokeWidth="2"
          className="stroke-muted"
        />
        {filled > 0 && (
          <circle
            cx={center}
            cy={center}
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
      {percent && (
        <text
          x={center}
          y={center}
          textAnchor="middle"
          dominantBaseline="central"
          className="fill-foreground text-[10px] font-medium"
        >
          {percent}
        </text>
      )}
    </svg>
  )
}

/** A small fill ring for the chat's options menu, where it opens the usage sheet. */
export function ContextIcon({ usage }: { usage: ContextUsage }) {
  return <ContextMeter usage={usage} size={16} />
}

/** A full-size context button for the chat header, opening its usage sheet. */
export function ContextRing({ usage, onClick }: { usage: ContextUsage; onClick: () => void }) {
  const percent = contextPercent(usage)

  return (
    <Button
      variant="outline"
      size="icon-lg"
      className="size-11 rounded-full border-0 bg-background/80 backdrop-blur"
      onClick={onClick}
      aria-label={percent ? `Context, ${percent}` : "Context"}
    >
      <ContextMeter usage={usage} size={44} percent={percent} />
    </Button>
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

function WindowRow({ window, now }: { window: UsageWindowView; now: number }) {
  const pct = window.usedPercent
  const near = pct >= 100 - NOTICE_REMAINING_PERCENT
  return (
    <Meter.Root value={pct} className="flex flex-col gap-2.5">
      <div className="flex items-baseline justify-between gap-4">
        <Meter.Label className="font-medium">{window.label}</Meter.Label>
        <span className="text-muted-foreground tabular-nums">{Math.round(pct)}% used</span>
      </div>
      <Meter.Track className="h-2 overflow-hidden rounded-full bg-background">
        <Meter.Indicator
          className={near ? "rounded-full bg-destructive" : "rounded-full bg-primary"}
        />
      </Meter.Track>
      {window.resetsAt && (
        <span className="text-sm text-muted-foreground tabular-nums">
          Resets in {resetsInText(window.resetsAt, now)} ({resetsAtText(window.resetsAt)})
        </span>
      )}
      {window.detail && <span className="text-sm text-muted-foreground">{window.detail}</span>}
    </Meter.Root>
  )
}

/** The warning shown above the composer when the provider's plan is near its limit. */
export function LimitBanner({
  notice,
  onDismiss,
  onView,
}: {
  notice: UsageWindowView
  onDismiss: () => void
  onView: () => void
}) {
  const exhausted = notice.remaining <= 0
  // A phone's banner leaves out the window's name: "Approaching Limit" is enough to send the
  // reader to the sheet, which names every window.
  const wide = useWide()
  // The line counts down while the banner is up: an "in 3d 4h" that never moves is wrong by then.
  const now = useNow()
  const text = exhausted
    ? wide
      ? `${notice.label} Limit Reached`
      : "Limit Reached"
    : wide
      ? `Approaching ${notice.label} Limit`
      : "Approaching Limit"
  return (
    <Banner
      tone={exhausted ? "error" : "warning"}
      action={
        <div className="flex items-center gap-1">
          <Button variant="outline" size="sm" onClick={onView}>
            View usage
          </Button>
          <Button
            variant="ghost"
            size="icon-sm"
            className="size-8 shrink-0"
            onClick={onDismiss}
            aria-label="Dismiss"
          >
            <XIcon />
          </Button>
        </div>
      }
    >
      <div className="flex flex-col">
        <span>{text}</span>
        {notice.resetsAt && (
          <span className="text-muted-foreground tabular-nums">
            Resets in {resetsInText(notice.resetsAt, now)}
          </span>
        )}
      </div>
    </Banner>
  )
}

export function UsageSheet({
  open,
  onOpenChange,
  usage,
  providerUsage,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  usage: ContextUsage
  providerUsage?: ProviderUsage
}) {
  const unreachable = useModelsDevUnreachable()
  const filled = fraction(usage)
  const windows = windowViews(providerUsage)
  // The reset lines count down while the sheet is open.
  const now = useNow()

  return (
    <Popup open={open} onOpenChange={onOpenChange}>
      <PopupContent>
        <PopupHeader className="pb-2">
          <PopupTitle>Usage</PopupTitle>
        </PopupHeader>
        <div className="flex flex-col gap-6 px-6 text-[15px]">
          {!usage.tracked && <Banner>Context tracking needs the Gots plugin.</Banner>}
          <Section title="Context">
            {/* What the meter measures, stated the way a Limits row states itself: a label, then
                its line. The model is picked in the composer's pill, so this one only reads. */}
            <div className="flex flex-col gap-1">
              <span className="font-medium">Current Model</span>
              <span className="truncate text-sm text-muted-foreground">
                {usage.model ?? "Not set"}
              </span>
            </div>
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
          {windows.length > 0 && (
            <Section title="Limits">
              {windows.map((w) => (
                <WindowRow key={w.label} window={w} now={now} />
              ))}
            </Section>
          )}
        </div>
      </PopupContent>
    </Popup>
  )
}

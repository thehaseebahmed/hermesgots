import { useEffect, useState } from "react"
import { Meter } from "@base-ui/react/meter"
import { Link } from "react-router"

import { Button } from "@/components/ui/button"
import { Sheet, SheetContent, SheetHeader, SheetTitle } from "@/components/ui/sheet"
import type { Profile } from "@/lib/db"
import { formatTokens } from "@/lib/format"
import { getModelInfo, type ModelInfo } from "@/lib/hermes"

export interface ContextUsage {
  /** Prompt tokens of the latest turn. */
  tokens?: number
  /** True when that turn ran tools, so Hermes's sum counts the prompt more than once. */
  approximate?: boolean
  window?: number
}

function fraction({ tokens, window }: ContextUsage) {
  return tokens && window ? Math.min(1, tokens / window) : 0
}

/** Small fill ring for the composer; opens the usage sheet. */
export function ContextRing({ usage, onClick }: { usage: ContextUsage; onClick: () => void }) {
  const filled = fraction(usage)
  const radius = 8
  const circumference = 2 * Math.PI * radius
  const label = usage.window
    ? `Context ${Math.round(filled * 100)}% used`
    : "Context usage and model"

  return (
    <Button
      type="button"
      variant="ghost"
      size="icon-lg"
      className="size-11 rounded-full text-muted-foreground"
      onClick={onClick}
      aria-label={label}
    >
      <svg viewBox="0 0 20 20" className="size-5 -rotate-90" aria-hidden>
        <circle cx="10" cy="10" r={radius} fill="none" strokeWidth="2.5" className="stroke-muted" />
        {filled > 0 && (
          <circle
            cx="10"
            cy="10"
            r={radius}
            fill="none"
            strokeWidth="2.5"
            strokeLinecap="round"
            strokeDasharray={circumference}
            strokeDashoffset={circumference * (1 - filled)}
            className={filled >= 0.9 ? "stroke-destructive" : "stroke-primary"}
          />
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

function Row({ label, value }: { label: string; value?: string }) {
  return (
    <div className="flex items-baseline justify-between gap-4">
      <span className="shrink-0">{label}</span>
      <span className="min-w-0 truncate text-right text-muted-foreground">
        {value ?? "Unknown"}
      </span>
    </div>
  )
}

export function UsageSheet({
  open,
  onOpenChange,
  usage,
  profile,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  usage: ContextUsage
  profile?: Profile | null
}) {
  const [info, setInfo] = useState<{ baseUrl: string; value: ModelInfo | null }>()
  const baseUrl = profile?.baseUrl ?? ""
  const apiKey = profile?.apiKey ?? ""

  useEffect(() => {
    if (!open || !baseUrl) return
    let cancelled = false
    void getModelInfo({ baseUrl, apiKey }).then((value) => {
      if (!cancelled) setInfo({ baseUrl, value })
    })
    return () => {
      cancelled = true
    }
  }, [open, baseUrl, apiKey])

  const filled = fraction(usage)
  const pending = Boolean(baseUrl) && info?.baseUrl !== baseUrl
  const known = pending ? undefined : info?.value

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent
        side="bottom"
        className="mx-auto max-h-[85dvh] w-full max-w-xl overflow-y-auto rounded-t-3xl pb-[max(1.5rem,env(safe-area-inset-bottom))] data-[side=bottom]:border-t-0"
      >
        <SheetHeader className="items-center pb-2">
          <SheetTitle>Usage</SheetTitle>
        </SheetHeader>
        <div className="flex flex-col gap-6 px-6 text-[15px]">
          <Section title="Context">
            {usage.window ? (
              <Meter.Root value={filled * 100} className="flex flex-col gap-2.5">
                <div className="flex items-baseline justify-between gap-4">
                  <Meter.Label className="font-medium">Context window</Meter.Label>
                  <span className="text-muted-foreground tabular-nums">
                    {usage.tokens ? `${Math.round(filled * 100)}% used` : "Not used yet"}
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
                  {usage.approximate ? "~" : ""}
                  {formatTokens(usage.tokens ?? 0)} of {formatTokens(usage.window)} tokens
                </span>
                {usage.approximate && (
                  <p className="text-xs text-muted-foreground">
                    The last turn ran tools, and Hermes counts the prompt once per model call, so
                    this reads high.
                  </p>
                )}
              </Meter.Root>
            ) : (
              <div className="flex flex-col items-start gap-3">
                <p className="text-sm text-muted-foreground">
                  {usage.tokens
                    ? `The last turn used ${formatTokens(usage.tokens)} prompt tokens. `
                    : ""}
                  Hermes doesn't report the model's context size. Set it on this bot to see how full
                  the chat is.
                </p>
                <Button
                  variant="outline"
                  className="min-h-11"
                  nativeButton={false}
                  render={<Link to="/settings" />}
                >
                  Set context window
                </Button>
              </div>
            )}
          </Section>

          <Section title="Model">
            <Row label="Bot model" value={profile?.model} />
            <Row label="Model" value={pending ? "…" : known?.model} />
            <Row label="Provider" value={pending ? "…" : known?.provider} />
          </Section>
        </div>
      </SheetContent>
    </Sheet>
  )
}

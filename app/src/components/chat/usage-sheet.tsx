import { useEffect, useMemo, useState } from "react"
import { Meter } from "@base-ui/react/meter"
import { ArrowLeftIcon, CheckIcon, ChevronRightIcon, SearchIcon } from "lucide-react"

import { Banner } from "@/components/banner"
import { Popup, PopupContent, PopupHeader, PopupTitle } from "@/components/popup"
import { Button } from "@/components/ui/button"
import { InputGroup, InputGroupAddon, InputGroupInput } from "@/components/ui/input-group"
import type { Conversation, Profile } from "@/lib/db"
import { formatTokens } from "@/lib/format"
import { getModelInfo, type ModelInfo, type ModelProvider } from "@/lib/hermes"
import { useModelsDevUnreachable } from "@/lib/models"
import { useNav } from "@/lib/nav"
import { cn } from "@/lib/utils"

type ModelChoice = NonNullable<Conversation["modelChoice"]>

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
  const label = usage.window ? `Context ${percent}% used` : "Context usage and model"

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
  choice,
  onChoose,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  usage: ContextUsage
  profile?: Profile | null
  /** The model picked for this chat, if any. */
  choice?: ModelChoice
  /** Picks the chat's model; undefined goes back to the bot's. */
  onChoose?: (choice: ModelChoice | undefined) => void
}) {
  const { root } = useNav()
  const [picking, setPicking] = useState(false)
  const unreachable = useModelsDevUnreachable()
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
  const providers = known?.providers ?? []
  const pickable = Boolean(onChoose && providers.length)
  const model = choice?.model ?? known?.model
  const providerSlug = choice?.provider ?? known?.provider
  const provider = providers.find((p) => p.slug === providerSlug)?.name ?? providerSlug

  return (
    <Popup
      open={open}
      onOpenChange={(next) => {
        onOpenChange(next)
        if (!next) setPicking(false)
      }}
    >
      <PopupContent>
        {picking && pickable ? (
          <ModelPicker
            providers={providers}
            current={{ provider: known?.provider, model: known?.model }}
            choice={choice}
            onBack={() => setPicking(false)}
            onChoose={(next) => {
              onChoose?.(next)
              setPicking(false)
            }}
          />
        ) : (
          <>
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

              <Section title="Model">
                {pickable ? (
                  <button
                    type="button"
                    className="-m-2 flex min-h-11 items-center justify-between gap-4 rounded-xl p-2 text-left transition-colors hover:bg-background/60 focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:outline-none"
                    onClick={() => setPicking(true)}
                  >
                    <span className="shrink-0">Model</span>
                    <span className="flex min-w-0 items-center gap-1 text-muted-foreground">
                      <span className="truncate">{model ?? "Unknown"}</span>
                      <ChevronRightIcon className="size-4 shrink-0" aria-hidden />
                    </span>
                  </button>
                ) : (
                  <Row label="Model" value={pending ? "…" : model} />
                )}
                <Row label="Provider" value={pending ? "…" : provider} />
              </Section>
            </div>
          </>
        )}
      </PopupContent>
    </Popup>
  )
}

function ModelPicker({
  providers,
  current,
  choice,
  onBack,
  onChoose,
}: {
  providers: ModelProvider[]
  /** What the bot runs on when the chat has no model of its own. */
  current: { provider?: string; model?: string }
  choice?: ModelChoice
  onBack: () => void
  onChoose: (choice: ModelChoice | undefined) => void
}) {
  const [query, setQuery] = useState("")
  const total = providers.reduce((n, p) => n + p.models.length, 0)
  const groups = useMemo(() => {
    const words = query.toLowerCase().split(/\s+/).filter(Boolean)
    return providers
      .map((p) => {
        const haystack = (m: string) => `${p.name} ${p.slug} ${m}`.toLowerCase()
        return { ...p, models: p.models.filter((m) => words.every((w) => haystack(m).includes(w))) }
      })
      .filter((p) => p.models.length)
  }, [providers, query])

  return (
    <>
      <PopupHeader className="flex-row items-center gap-1 pb-2">
        <Button
          variant="ghost"
          size="icon-lg"
          className="-ml-2 size-11 rounded-full"
          onClick={onBack}
          aria-label="Back to usage"
        >
          <ArrowLeftIcon />
        </Button>
        <PopupTitle className="min-w-0 flex-1 truncate">Model</PopupTitle>
      </PopupHeader>
      <div className="flex flex-col gap-5 px-6 text-[15px]">
        {total > 8 && (
          <InputGroup className="h-11">
            <InputGroupAddon>
              <SearchIcon />
            </InputGroupAddon>
            <InputGroupInput
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search models"
              aria-label="Search models"
            />
          </InputGroup>
        )}
        {!query && (
          <ModelList>
            <ModelOption
              label="Bot's model"
              detail={current.model}
              selected={!choice}
              onClick={() => onChoose(undefined)}
            />
          </ModelList>
        )}
        {groups.map((p) => (
          <section key={p.slug} className="flex flex-col gap-2">
            <h3 className="px-1 text-sm text-muted-foreground">{p.name}</h3>
            <ModelList>
              {p.models.map((m) => (
                <ModelOption
                  key={m}
                  label={m}
                  selected={choice?.provider === p.slug && choice.model === m}
                  onClick={() => onChoose({ provider: p.slug, model: m })}
                />
              ))}
            </ModelList>
          </section>
        ))}
        {query && !groups.length && (
          <p className="px-1 text-sm text-muted-foreground">No models match.</p>
        )}
      </div>
    </>
  )
}

function ModelList({ children }: { children: React.ReactNode }) {
  return <div className="flex flex-col overflow-hidden rounded-2xl bg-muted/60 p-1">{children}</div>
}

function ModelOption({
  label,
  detail,
  selected,
  onClick,
}: {
  label: string
  detail?: string
  selected: boolean
  onClick: () => void
}) {
  return (
    <button
      type="button"
      aria-pressed={selected}
      className={cn(
        "flex min-h-11 items-center gap-3 rounded-xl px-3 py-2 text-left transition-colors hover:bg-background/60 focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:outline-none",
        selected && "bg-background",
      )}
      onClick={onClick}
    >
      <span className="flex min-w-0 flex-1 flex-col">
        <span className="break-all">{label}</span>
        {detail && <span className="truncate text-sm text-muted-foreground">{detail}</span>}
      </span>
      {selected && <CheckIcon className="size-4 shrink-0 text-primary" aria-hidden />}
    </button>
  )
}

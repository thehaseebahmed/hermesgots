import { useMemo, useState, type ReactNode } from "react"
import { ArrowLeftIcon, CheckIcon, ChevronDownIcon, SearchIcon } from "lucide-react"

import { Popup, PopupContent, PopupHeader, PopupTitle } from "@/components/popup"
import { Button } from "@/components/ui/button"
import { InputGroup, InputGroupAddon, InputGroupInput } from "@/components/ui/input-group"
import { rememberModel, type ModelChoice, type Profile } from "@/lib/db"
import type { ModelProvider } from "@/lib/hermes"
import { shortModel, useModelInfo } from "@/lib/model-info"
import { cn } from "@/lib/utils"

/**
 * The list of the host's models. The first row clears the choice and names what that runs on:
 * the bot's own default in a chat, the host's model in a bot's settings.
 */
export function ModelPicker({
  providers,
  fallback,
  recent = [],
  choice,
  onChoose,
  onBack,
}: {
  providers: ModelProvider[]
  /** The row that clears the choice: its label and the model it runs. */
  fallback: { label: string; model?: string }
  /** The bot's recently picked models, shown first as `provider/model`. */
  recent?: ModelChoice[]
  choice?: ModelChoice
  onChoose: (choice: ModelChoice | undefined) => void
  onBack?: () => void
}) {
  const [query, setQuery] = useState("")
  const total = providers.reduce((n, p) => n + p.models.length, 0)
  // Only ones the host still offers, so a recent pick never sends a model it dropped.
  const recentOffered = recent.filter((r) =>
    providers.some((p) => p.slug === r.provider && p.models.includes(r.model)),
  )
  const isChosen = (m: ModelChoice) => choice?.provider === m.provider && choice.model === m.model
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
        {onBack && (
          <Button
            variant="ghost"
            size="icon-lg"
            className="-ml-2 size-11 rounded-full"
            onClick={onBack}
            aria-label="Back"
          >
            <ArrowLeftIcon />
          </Button>
        )}
        <PopupTitle className={cn("min-w-0 flex-1 truncate", !onBack && "text-center")}>
          Model
        </PopupTitle>
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
              label={fallback.label}
              detail={fallback.model}
              selected={!choice}
              onClick={() => onChoose(undefined)}
            />
          </ModelList>
        )}
        {!query && recentOffered.length > 0 && (
          <section className="flex flex-col gap-2">
            <h3 className="px-1 text-sm text-muted-foreground">Recent</h3>
            <ModelList>
              {recentOffered.map((m) => (
                <ModelOption
                  key={`${m.provider}/${m.model}`}
                  label={`${m.provider}/${m.model}`}
                  selected={isChosen(m)}
                  onClick={() => onChoose(m)}
                />
              ))}
            </ModelList>
          </section>
        )}
        {groups.map((p) => (
          <section key={p.slug} className="flex flex-col gap-2">
            <h3 className="px-1 text-sm text-muted-foreground">{p.name}</h3>
            <ModelList>
              {p.models.map((m) => (
                <ModelOption
                  key={m}
                  label={m}
                  selected={isChosen({ provider: p.slug, model: m })}
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

function ModelList({ children }: { children: ReactNode }) {
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

/**
 * The composer's model pill: what this chat runs on, opening the host's models. A pick holds for
 * this chat only; the bot's default is set in its settings.
 */
export function ModelMenu({
  profile,
  choice,
  onChoose,
  disabled,
}: {
  profile?: Profile | null
  choice?: ModelChoice
  onChoose: (choice: ModelChoice | undefined) => void
  disabled?: boolean
}) {
  const [open, setOpen] = useState(false)
  const info = useModelInfo(profile)
  const providers = info?.providers ?? []
  const fallback = profile?.modelChoice?.model ?? info?.model
  const current = choice?.model ?? fallback
  // Nothing to pick from (an older Hermes, a host that's down, a keyless bot still loading).
  if (!current && !providers.length) return null
  return (
    <>
      <Button
        type="button"
        variant="secondary"
        className="h-11 max-w-48 min-w-0 gap-1 rounded-full pr-2.5 pl-3.5 sm:max-w-64"
        disabled={disabled || !providers.length}
        onClick={() => setOpen(true)}
        aria-label={`Model: ${current ?? "Unknown"}`}
      >
        <span className="truncate">{current ? shortModel(current) : "Model"}</span>
        {providers.length > 0 && <ChevronDownIcon className="text-muted-foreground" />}
      </Button>
      <Popup open={open} onOpenChange={setOpen}>
        <PopupContent>
          <ModelPicker
            providers={providers}
            fallback={{ label: "Bot's default", model: fallback }}
            recent={profile?.recentModels}
            choice={choice}
            onChoose={(next) => {
              onChoose(next)
              if (next && profile) void rememberModel(profile.id, next)
              setOpen(false)
            }}
          />
        </PopupContent>
      </Popup>
    </>
  )
}

/** A bot's default model, in its settings: what its chats run on unless they pick another. */
export function DefaultModelSetting({
  profile,
  onChoose,
}: {
  profile: Profile
  onChoose: (choice: ModelChoice | undefined) => void
}) {
  const [open, setOpen] = useState(false)
  const info = useModelInfo(profile)
  const providers = info?.providers ?? []
  const current = profile.modelChoice?.model ?? info?.model
  return (
    <>
      <Button
        id="default-model"
        type="button"
        variant="outline"
        className="h-11 w-full justify-between gap-2 font-normal"
        disabled={!providers.length}
        onClick={() => setOpen(true)}
      >
        <span className="truncate">{current ?? (info === undefined ? "…" : "Unknown")}</span>
        <ChevronDownIcon className="text-muted-foreground" />
      </Button>
      <Popup open={open} onOpenChange={setOpen}>
        <PopupContent>
          <ModelPicker
            providers={providers}
            fallback={{ label: "Host's model", model: info?.model }}
            recent={profile.recentModels}
            choice={profile.modelChoice}
            onChoose={(next) => {
              onChoose(next)
              if (next) void rememberModel(profile.id, next)
              setOpen(false)
            }}
          />
        </PopupContent>
      </Popup>
    </>
  )
}

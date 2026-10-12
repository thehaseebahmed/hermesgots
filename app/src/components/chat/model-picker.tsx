import { useEffect, useMemo, useRef, useState, type ReactNode } from "react"
import {
  ArrowLeftIcon,
  CheckIcon,
  ChevronDownIcon,
  ChevronRightIcon,
  SearchIcon,
} from "lucide-react"

import { Popup, PopupContent, PopupHeader, PopupTitle } from "@/components/popup"
import { Button } from "@/components/ui/button"
import { InputGroup, InputGroupAddon, InputGroupInput } from "@/components/ui/input-group"
import { rememberModel, type ModelChoice, type Profile } from "@/lib/db"
import type { ModelInfo, ModelProvider } from "@/lib/hermes"
import { shortModel, useModelInfo } from "@/lib/model-info"
import { cn } from "@/lib/utils"

/**
 * The list of the host's models. The first row clears the choice and names what that runs on:
 * the bot's own default in a chat, the host's model in a bot's settings. Below the recent picks
 * each provider opens its own models; a search looks through every provider's.
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
  const [openSlug, setOpenSlug] = useState<string>()
  const sorted = useMemo(() => sortProviders(providers), [providers])
  const root = useRef<HTMLDivElement>(null)
  // A host with one provider has nothing to choose between, so its models show at once.
  const open = sorted.length === 1 ? sorted[0] : sorted.find((p) => p.slug === openSlug)
  const total = (open ? [open] : sorted).reduce((n, p) => n + p.models.length, 0)
  // Only ones the host still offers, so a recent pick never sends a model it dropped.
  const recentOffered = recent.filter((r) =>
    providers.some((p) => p.slug === r.provider && p.models.includes(r.model)),
  )
  const isChosen = (m: ModelChoice) => choice?.provider === m.provider && choice.model === m.model
  const groups = useMemo(() => {
    const words = query.toLowerCase().split(/\s+/).filter(Boolean)
    return (open ? [open] : sorted)
      .map((p) => {
        const haystack = (m: string) => `${p.name} ${p.slug} ${m}`.toLowerCase()
        return { ...p, models: p.models.filter((m) => words.every((w) => haystack(m).includes(w))) }
      })
      .filter((p) => p.models.length)
  }, [sorted, open, query])

  const show = (slug: string | undefined) => {
    setOpenSlug(slug)
    setQuery("")
  }
  // The popup's scroller, so a list doesn't open where the last one was left. Braced: Chrome 150+
  // returns a Promise from scrollTo, which React would call as the effect's cleanup.
  useEffect(() => {
    root.current?.parentElement?.scrollTo({ top: 0 })
  }, [openSlug])
  const drilled = open && sorted.length > 1
  const back = drilled ? () => show(undefined) : onBack
  const top = !query && !drilled

  return (
    <>
      <PopupHeader className="flex-row items-center gap-1 pb-2">
        {back && (
          <Button
            variant="ghost"
            size="icon-lg"
            className="-ml-2 size-11 rounded-full"
            onClick={back}
            aria-label="Back"
          >
            <ArrowLeftIcon />
          </Button>
        )}
        <PopupTitle className={cn("min-w-0 flex-1 truncate", !back && "text-center")}>
          {drilled ? open.name : "Model"}
        </PopupTitle>
      </PopupHeader>
      <div ref={root} className="flex flex-col gap-5 px-6 text-[15px]">
        {total > 8 && (
          <InputGroup className="h-11">
            <InputGroupAddon>
              <SearchIcon />
            </InputGroupAddon>
            <InputGroupInput
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder={drilled ? `Search ${open.name}` : "Search models"}
              aria-label="Search models"
            />
          </InputGroup>
        )}
        {top && (
          <ModelList>
            <ModelOption
              label={fallback.label}
              detail={fallback.model}
              selected={!choice}
              onClick={() => onChoose(undefined)}
            />
          </ModelList>
        )}
        {top && recentOffered.length > 0 && (
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
        {top && !open ? (
          <section className="flex flex-col gap-2">
            <h3 className="px-1 text-sm text-muted-foreground">Providers</h3>
            <ModelList>
              {sorted.map((p) => {
                return (
                  <ModelOption
                    key={p.slug}
                    label={p.name}
                    detail={`${p.models.length} ${p.models.length === 1 ? "model" : "models"}`}
                    selected={false}
                    opens
                    onClick={() => show(p.slug)}
                  />
                )
              })}
            </ModelList>
          </section>
        ) : (
          groups.map((p) => (
            <section key={p.slug} className="flex flex-col gap-2">
              {!drilled && <h3 className="px-1 text-sm text-muted-foreground">{p.name}</h3>}
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
          ))
        )}
        {query && !groups.length && (
          <p className="px-1 text-sm text-muted-foreground">No models match.</p>
        )}
      </div>
    </>
  )
}

function hostChoice(info: ModelInfo | null | undefined): ModelChoice | undefined {
  return info?.model ? { provider: info.provider ?? "", model: info.model } : undefined
}

// A fixed height, so the sheet doesn't grow and shrink between the lists.
const PICKER_HEIGHT = "h-[min(36rem,85dvh)]"

const byName = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" })

/** Providers and each one's models, A to Z, so a list never reorders itself. */
function sortProviders(providers: ModelProvider[]) {
  return providers
    .map((p) => ({ ...p, models: [...p.models].sort(byName.compare) }))
    .sort((a, b) => byName.compare(a.name, b.name))
}

/** `provider/model`, or the model alone when the host didn't name its provider. */
function fullModel({ provider, model }: ModelChoice) {
  return provider ? `${provider}/${model}` : model
}

function ModelList({ children }: { children: ReactNode }) {
  return <div className="flex flex-col overflow-hidden rounded-2xl bg-muted/60 p-1">{children}</div>
}

function ModelOption({
  label,
  detail,
  selected,
  opens,
  onClick,
}: {
  label: string
  detail?: string
  selected: boolean
  /** Opens a list of its own rather than picking. */
  opens?: boolean
  onClick: () => void
}) {
  return (
    <button
      type="button"
      aria-pressed={opens ? undefined : selected}
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
      {opens && <ChevronRightIcon className="size-4 shrink-0 text-muted-foreground" aria-hidden />}
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
  // The host's last reported model, shown greyed while it's read again. Only a bot whose host runs
  // the Memento plugin shows it; one without the plugin keeps showing nothing until the host answers.
  const remembered = profile?.pluginVersion ? profile.hostModel?.model : undefined
  let current = choice?.model ?? profile?.modelChoice?.model ?? info?.model
  let stale = false
  if (!current && remembered) {
    current = remembered
    stale = true
  }
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
        <span className={cn("truncate", stale && "text-muted-foreground")}>
          {current ? shortModel(current) : "Model"}
        </span>
        {providers.length > 0 && <ChevronDownIcon className="text-muted-foreground" />}
      </Button>
      <Popup open={open} onOpenChange={setOpen}>
        <PopupContent initialFocus={false} className={PICKER_HEIGHT}>
          <ModelPicker
            providers={providers}
            fallback={{
              label: "Default",
              model: profile?.modelChoice?.model ?? info?.model ?? remembered,
            }}
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

// How long a just-saved default stays on show while the host's model is read again.
const SETTLE_MS = 4000

/** A bot's default model, in its settings: what its chats run on unless they pick another. */
export function DefaultModelSetting({
  profile,
  onChoose,
}: {
  profile: Profile
  onChoose: (choice: ModelChoice | undefined) => Promise<void>
}) {
  const [open, setOpen] = useState(false)
  // The pick while the host saves it, so the field doesn't flick back to the old model.
  const [saving, setSaving] = useState<ModelChoice>()
  const info = useModelInfo(profile)
  const providers = info?.providers ?? []
  const host = hostChoice(info)
  const hostModel = profile.hostModel
  // Until the host answers, the model it last had, greyed out.
  const loading = info === undefined && !saving
  const current = saving ?? profile.modelChoice ?? (loading ? hostModel : host)
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
        <span className={cn("truncate", loading && "text-muted-foreground")}>
          {current ? fullModel(current) : loading ? "…" : "Unknown"}
        </span>
        <ChevronDownIcon className="text-muted-foreground" />
      </Button>
      <Popup open={open} onOpenChange={setOpen}>
        <PopupContent initialFocus={false} className={PICKER_HEIGHT}>
          <ModelPicker
            providers={providers}
            fallback={{ label: "Default", model: info?.model }}
            recent={profile.recentModels}
            choice={profile.modelChoice}
            onChoose={(next) => {
              setSaving(next)
              // The host's answer lags the write, so the pick stays on show until it's read again.
              void onChoose(next).finally(() => setTimeout(() => setSaving(undefined), SETTLE_MS))
              if (next) void rememberModel(profile.id, next)
              setOpen(false)
            }}
          />
        </PopupContent>
      </Popup>
    </>
  )
}

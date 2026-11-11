import { useMemo, useRef, useState } from "react"
import { BrainIcon, EyeIcon, type LucideIcon } from "lucide-react"
import {
  ArrowLeftIcon,
  ChevronDownIcon,
  PlusIcon,
  XIcon,
} from "lucide-react"
import { toast } from "sonner"

import { MODEL_SORTS, sortByFacts, type ModelSort } from "@/components/chat/model-sort"
import { SortMenu } from "@/components/sort-menu"
import { defaultSort, type Sort } from "@/lib/sort"
import { PickGroup, PickRow } from "@/components/pick-row"
import { SearchField } from "@/components/search-field"
import { Popup, PopupContent, PopupHeader, PopupTitle } from "@/components/popup"
import { usePopupForm } from "@/lib/popup-form"
import { Button } from "@/components/ui/button"
import { Field, FieldDescription, FieldLabel } from "@/components/ui/field"
import { Spinner } from "@/components/ui/spinner"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import { rememberModel, type ModelChoice, type Profile } from "@/lib/db"
import { MAX_FALLBACKS, withFallback } from "@/lib/fallback-list"
import { useFallbackModels } from "@/lib/fallbacks"
import { formatTokens } from "@/lib/format"
import type { ModelProvider } from "@/lib/hermes"
import { botModel, fullModel, hostChoice, shortModel, useModelInfo } from "@/lib/model-info"
import { MAX_COST_TIER, modelFacts, useModelCatalog, type Catalog } from "@/lib/models"
import { overallScoreOf, useOverallRankings, type RankingsPayload } from "@/lib/rankings"
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
  header = true,
}: {
  providers: ModelProvider[]
  /** The row that clears the choice: its label and the model it runs. */
  fallback: { label: string; model?: string }
  /** The bot's recently picked models, shown first as `provider/model`. */
  recent?: ModelChoice[]
  choice?: ModelChoice
  onChoose: (choice: ModelChoice | undefined) => void
  /** Whether the picker draws its own sheet header; a card or a dialog already says the title. */
  header?: boolean
}) {
  const [query, setQuery] = useState("")
  const [openSlug, setOpenSlug] = useState<string>()
  const [sort, setSort] = useState<Sort<ModelSort>>(() => defaultSort(MODEL_SORTS))
  // The cached models.dev catalog, live: each row's facts repaint when a refresh lands.
  const catalog = useModelCatalog()
  // The cached BenchLM overall rankings, live: each row's score repaints when a refresh lands.
  const rankings = useOverallRankings()
  const sorted = useMemo(() => sortProviders(providers), [providers])
  // A host with one provider has nothing to choose between, so its models show at once.
  const drilled = sorted.length === 1 ? sorted[0] : sorted.find((p) => p.slug === openSlug)
  const total = (drilled ? [drilled] : sorted).reduce((n, p) => n + p.models.length, 0)
  // Only ones the host still offers, so a recent pick never sends a model it dropped.
  const recentOffered = recent.filter((r) =>
    providers.some((p) => p.slug === r.provider && p.models.includes(r.model)),
  )
  const isChosen = (m: ModelChoice) => choice?.provider === m.provider && choice.model === m.model
  const groups = useMemo(() => {
    const words = query.toLowerCase().split(/\s+/).filter(Boolean)
    return (drilled ? [drilled] : sorted)
      .map((p) => {
        const haystack = (m: string) => `${p.name} ${p.slug} ${m}`.toLowerCase()
        const matched = p.models.filter((m) => words.every((w) => haystack(m).includes(w)))
        // Price ranks by the blended cost, context by the window, BenchLM by the overall score.
        return {
          ...p,
          models: sortByFacts(
            sort,
            (m) => ({
              ...modelFacts(catalog, { provider: p.slug, model: m }),
              benchlm:
                sort.key === "benchlm"
                  ? overallScoreOf(rankings, { provider: p.slug, model: m })
                  : undefined,
            }),
            matched,
          ),
        }
      })
      .filter((p) => p.models.length)
  }, [sorted, drilled, query, sort, catalog, rankings])

  const form = usePopupForm()
  // A menu has no sheet to stack on, so a provider's models take its place, with a way back.
  if (form === "menu" && drilled && sorted.length > 1)
    return (
      <ProviderModels
        provider={drilled}
        catalog={catalog}
        rankings={rankings}
        isChosen={isChosen}
        onChoose={onChoose}
        onBack={() => setOpenSlug(undefined)}
      />
    )

  const top = !query && !drilled
  // The sort menu orders a flat model list; the providers list stays A to Z, so it shows no menu.
  const flat = Boolean(drilled) || query.length > 0

  return (
    <>
      {header && (
        <PopupHeader>
          <PopupTitle>{drilled ? drilled.name : "Select Model"}</PopupTitle>
        </PopupHeader>
      )}
      <div className="flex flex-col gap-5 px-6 pt-2 text-[15px]">
        {(total > 8 || flat) && (
          <div className="flex items-center gap-2">
            {total > 8 && (
              <SearchField
              value={query}
              onChange={setQuery}
              label={drilled ? `Search ${drilled.name}` : "Search models"}
              className="min-w-0 flex-1"
            />
            )}
            {/* Only a flat list sorts: the providers list stays A to Z, so it shows no menu. */}
            {flat && <ModelSortMenu sort={sort} onSort={setSort} />}
          </div>
        )}
        {top && (
          <PickGroup mode="choose" surface="plate" label="Default">
            <PickRow
              title={fallback.label}
              line={fallback.model}
              selected={!choice}
              onPick={() => onChoose(undefined)}
            />
          </PickGroup>
        )}
        {top && recentOffered.length > 0 && (
          <PickGroup mode="choose" surface="plate" heading="Recent">
            {recentOffered.map((m) => (
              <PickRow
                key={fullModel(m)}
                title={fullModel(m)}
                line={modelDetail(catalog, rankings, m)}
                selected={isChosen(m)}
                onPick={() => onChoose(m)}
              />
            ))}
          </PickGroup>
        )}
        {top && !drilled ? (
          <PickGroup mode="open" surface="plate" heading="Providers">
            {sorted.map((p) => (
              <PickRow
                key={p.slug}
                title={p.name}
                line={`${p.models.length} ${p.models.length === 1 ? "model" : "models"}`}
                onPick={() => setOpenSlug(p.slug)}
              />
            ))}
          </PickGroup>
        ) : (
          groups.map((p) => (
            <PickGroup
              key={p.slug}
              mode="choose"
              surface="plate"
              heading={drilled ? undefined : p.name}
              label={p.name}
            >
              {p.models.map((m) => (
                <PickRow
                  key={m}
                  title={m}
                  line={modelDetail(catalog, rankings, { provider: p.slug, model: m })}
                  selected={isChosen({ provider: p.slug, model: m })}
                  onPick={() => onChoose({ provider: p.slug, model: m })}
                />
              ))}
            </PickGroup>
          ))
        )}
        {query && !groups.length && (
          <p className="px-1 text-sm text-muted-foreground">No models match.</p>
        )}
      </div>
      {/* A provider's models open as a sheet stacked on this one, dismissed back to it; it
          renders inside this sheet's tree so Base UI registers the nesting. */}
      {drilled && form !== "menu" && (
        <Popup open onOpenChange={(next) => !next && setOpenSlug(undefined)}>
          <PopupContent initialFocus={false} fixedHeight={PICKER_HEIGHT}>
            <ProviderModels
              provider={drilled}
              catalog={catalog}
              rankings={rankings}
              isChosen={isChosen}
              onChoose={onChoose}
            />
          </PopupContent>
        </Popup>
      )}
    </>
  )
}

/** One provider's models, for the sheet stacked over the picker: search at once, no drill. */
function ProviderModels({
  provider,
  catalog,
  rankings,
  isChosen,
  onChoose,
  onBack,
}: {
  provider: ModelProvider
  catalog: Catalog | undefined
  rankings: RankingsPayload | undefined
  isChosen: (m: ModelChoice) => boolean
  onChoose: (choice: ModelChoice | undefined) => void
  /** Back to the providers, where the models take the picker's place rather than stack on it. */
  onBack?: () => void
}) {
  const [query, setQuery] = useState("")
  const [sort, setSort] = useState<Sort<ModelSort>>(() => defaultSort(MODEL_SORTS))
  const models = useMemo(() => {
    const words = query.toLowerCase().split(/\s+/).filter(Boolean)
    const haystack = (m: string) => `${provider.name} ${provider.slug} ${m}`.toLowerCase()
    const matched = provider.models.filter((m) => words.every((w) => haystack(m).includes(w)))
    return sortByFacts(
      sort,
      (m) => ({
        ...modelFacts(catalog, { provider: provider.slug, model: m }),
        benchlm: overallScoreOf(rankings, { provider: provider.slug, model: m }),
      }),
      matched,
    )
  }, [provider, query, sort, catalog, rankings])
  return (
    <>
      <PopupHeader className={cn(onBack && "pl-16")}>
        {onBack && (
          <Button
            variant="ghost"
            size="icon-lg"
            className="absolute top-1.5 left-2 size-11"
            aria-label="All providers"
            onClick={onBack}
          >
            <ArrowLeftIcon />
          </Button>
        )}
        <PopupTitle>{provider.name}</PopupTitle>
      </PopupHeader>
      <div className="flex flex-col gap-5 px-6 pt-2 text-[15px]">
        <div className="flex items-center gap-2">
          <SearchField
            value={query}
            onChange={setQuery}
            label={`Search ${provider.name}`}
            className="min-w-0 flex-1"
          />
          <ModelSortMenu sort={sort} onSort={setSort} />
        </div>
        {models.length ? (
          <PickGroup mode="choose" surface="plate" label={provider.name}>
            {models.map((m) => (
              <PickRow
                key={m}
                title={m}
                line={modelDetail(catalog, rankings, { provider: provider.slug, model: m })}
                selected={isChosen({ provider: provider.slug, model: m })}
                onPick={() => onChoose({ provider: provider.slug, model: m })}
              />
            ))}
          </PickGroup>
        ) : (
          <p className="px-1 text-sm text-muted-foreground">No models match.</p>
        )}
      </div>
    </>
  )
}

function ModelSortMenu({ sort, onSort }: { sort: Sort<ModelSort>; onSort: (sort: Sort<ModelSort>) => void }) {
  return (
    <SortMenu by="models" options={MODEL_SORTS} value={sort} onSort={onSort} compact />
  )
}

const byName = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" })

/** Providers and each one's models, A to Z, so a list never reorders itself. */
function sortProviders(providers: ModelProvider[]) {
  return providers
    .map((p) => ({ ...p, models: [...p.models].sort(byName.compare) }))
    .sort((a, b) => byName.compare(a.name, b.name))
}

/** The dim a fixed slot gets when the model isn't known to have it. */
const DIM = "opacity-40"

interface Capability {
  key: "vision" | "reasoning"
  label: string
  /** What the mark reads as when the catalog says the model lacks it. */
  off: string
  Icon: LucideIcon
}

/** The capability marks every row draws, in order. */
const CAPABILITIES: Capability[] = [
  { key: "vision", label: "Vision", off: "No vision", Icon: EyeIcon },
  { key: "reasoning", label: "Reasoning", off: "No reasoning", Icon: BrainIcon },
]

/**
 * A capability mark: a lucide icon with a tooltip naming the capability, dimmed when the model
 * isn't known to have it.
 */
function CapabilityMark({
  capability,
  supported,
}: {
  capability: Capability
  supported?: boolean
}) {
  const { Icon } = capability
  const label = supported === false ? capability.off : capability.label
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <span
            aria-label={label}
            className={cn("inline-flex align-[-2px]", supported !== true && DIM)}
          />
        }
      >
        <Icon className="size-3.5" aria-hidden="true" />
      </TooltipTrigger>
      <TooltipContent>{label}</TooltipContent>
    </Tooltip>
  )
}

/** The cost as fixed dollar slots: the band's signs lit, the rest dimmed, so every row lines up. */
function CostSigns({ tier }: { tier: number | undefined }) {
  const lit = tier ?? 0
  return (
    <span className="inline-flex">
      {"$".repeat(lit)}
      {MAX_COST_TIER > lit && <span className={DIM}>{"$".repeat(MAX_COST_TIER - lit)}</span>}
    </span>
  )
}

/** `BenchLM 87`, `BenchLM ?` for a loaded payload with no row, nothing before the payload lands. */
function benchlmLabel(score: number | undefined, rankings: RankingsPayload | undefined) {
  if (score !== undefined) return `BenchLM ${Math.round(score)}`
  // "?" only once the payload is loaded: before that, no score is shown rather than a false miss.
  return rankings ? "BenchLM ?" : null
}

/**
 * A model row's muted second line, one shape in a fixed order: the BenchLM score, the cost, the
 * model's capabilities, then the context window. The score and the context drop out when unknown;
 * the cost and both capability marks always show, dimmed when the model isn't known to have them.
 * A model models.dev doesn't list shows its score and a dash where the rest would be, or `—` when
 * BenchLM doesn't rank it either, and no line at all while the catalog is still loading.
 */
function modelDetail(
  catalog: Catalog | undefined,
  rankings: RankingsPayload | undefined,
  choice: ModelChoice,
) {
  if (!catalog) return undefined
  const facts = modelFacts(catalog, choice)
  const benchlm = benchlmLabel(overallScoreOf(rankings, choice), rankings)
  // The score stands on its own: models.dev knows nothing else about an unlisted model.
  if (!facts.listed) return benchlm ? `${benchlm} · —` : "—"
  return (
    <>
      {benchlm && `${benchlm} · `}
      <CostSigns tier={facts.tier} />
      {" · "}
      <span className="inline-flex items-center gap-1">
        {CAPABILITIES.map((capability) => (
          <CapabilityMark
            key={capability.key}
            capability={capability}
            supported={facts[capability.key]}
          />
        ))}
      </span>
      {facts.context ? ` · ${formatTokens(facts.context)}` : null}
    </>
  )
}


// A fixed height, so the sheet doesn't grow and shrink between the lists.
export const PICKER_HEIGHT = "h-[min(36rem,85dvh)]"

/**
 * The composer's model pill: what this chat runs on, opening the host's models. A pick holds for
 * this chat only; the bot's default is set in its settings.
 */
export function ModelMenu({
  profile,
  choice,
  onChoose,
  disabled,
  display = "pill",
}: {
  profile?: Profile | null
  choice?: ModelChoice
  onChoose: (choice: ModelChoice | undefined) => void
  disabled?: boolean
  /**
   * How the pill shows: a compact pill in the composer, or a full-width row naming the model's
   * provider, for a pick that stands alone in the plan-ready card.
   */
  display?: "pill" | "block"
}) {
  const [open, setOpen] = useState(false)
  const button = useRef<HTMLButtonElement>(null)
  const info = useModelInfo(profile)
  const providers = info?.providers ?? []
  // The host's last reported model, shown greyed while it's read again. Only a bot whose host runs
  // the Gots plugin shows it; one without the plugin keeps showing nothing until the host answers.
  const remembered = profile?.pluginVersion ? profile.hostModel?.model : undefined
  // One pick, so the name and its provider can't come from different models.
  const shown = choice ?? profile?.modelChoice ?? hostChoice(info)
  let current = shown?.model
  let stale = false
  if (!current && remembered) {
    current = remembered
    stale = true
  }
  // `provider/model` is how the app names a model everywhere else, so the row's pill follows it.
  const label = !current
    ? "Model"
    : display === "block" && shown?.provider
      ? fullModel({ provider: shown.provider, model: current })
      : shortModel(current)
  // Nothing to pick from (an older Hermes, a host that's down, a keyless bot still loading).
  if (!current && !providers.length) return null
  return (
    <>
      <Button
        ref={button}
        type="button"
        variant="secondary"
        className={cn(
          "h-11 min-w-0 gap-1 rounded-full pr-2.5 pl-3.5",
          display === "block" ? "w-full justify-between" : "max-w-48 sm:max-w-64",
        )}
        disabled={disabled || !providers.length}
        onClick={() => setOpen(true)}
        aria-label={`Model: ${current ? label : "Unknown"}`}
      >
        <span className={cn("min-w-0 truncate", stale && "text-muted-foreground")}>{label}</span>
        {providers.length > 0 && <ChevronDownIcon className="shrink-0 text-muted-foreground" />}
      </Button>
      <Popup open={open} onOpenChange={setOpen} anchor={button}>
        <PopupContent initialFocus={false} fixedHeight={PICKER_HEIGHT}>
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

function reportWrite(write: Promise<unknown>) {
  void write.catch((error: unknown) => {
    toast.error(error instanceof Error ? error.message : String(error))
  })
}

/** A bot's default model, in its settings: what its chats run on unless they pick another. */
export function DefaultModelSetting({
  profile,
  onChoose,
}: {
  profile: Profile
  onChoose: (choice: ModelChoice | undefined) => Promise<void>
}) {
  const [open, setOpen] = useState(false)
  const field = useRef<HTMLButtonElement>(null)
  // The pick while the host saves it, so the field doesn't flick back to the old model.
  const [saving, setSaving] = useState<ModelChoice>()
  const info = useModelInfo(profile)
  const providers = info?.providers ?? []
  const hostModel = profile.hostModel
  // Until the host answers, the model it last had, greyed out: it's remembered, not a live answer.
  const loading = info === undefined && !saving
  const current = saving ?? botModel(profile, info)
  const stale = Boolean(hostModel) && current === hostModel
  return (
    <>
      <Button
        ref={field}
        id="default-model"
        type="button"
        variant="outline"
        className="h-11 w-full justify-between gap-2 font-normal"
        disabled={!providers.length}
        onClick={() => setOpen(true)}
      >
        <span className={cn("truncate", stale && "text-muted-foreground")}>
          {current ? fullModel(current) : loading ? "…" : "Unknown"}
        </span>
        <ChevronDownIcon className="text-muted-foreground" />
      </Button>
      <Popup open={open} onOpenChange={setOpen} anchor={field}>
        <PopupContent initialFocus={false} fixedHeight={PICKER_HEIGHT}>
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

/**
 * A bot's fallback providers, in its settings: the picks its host records after the default, in the
 * order it holds them. A host whose plugin can't record them shows no field at all, and a write on
 * its way greys the rows out until the host's answer lands.
 */
export function FallbackModelsSetting({ profile }: { profile: Profile }) {
  // The slot the picker is open on: a row's index, the add row's place at the end of the list,
  // nothing while it's shut.
  const [open, setOpen] = useState<number>()
  // The row the picker opened from, which it sits beside as a menu.
  const opener = useRef<HTMLElement | null>(null)
  const { list, supported, saving, save } = useFallbackModels(profile)
  const providers = useModelInfo(profile)?.providers ?? []
  if (!supported) return null
  // A row's picker needs the host's model list, and a write on its way blocks every pick regardless.
  const cannotEdit = !providers.length || saving

  const chosen = open === undefined ? undefined : list[open]

  return (
    <Field aria-labelledby="fallback-models-label" aria-busy={saving || undefined}>
      <div className="flex items-center gap-2">
        <FieldLabel id="fallback-models-label">Fallback providers</FieldLabel>
        {saving && <Spinner className="size-3.5" />}
      </div>
      <FieldDescription>The chain Hermes tries after the main model</FieldDescription>
      <div className="space-y-2">
        {list.map((fallback, index) => (
          <div key={index} className="flex items-center gap-1">
            <Button
              id={`fallback-${index + 1}`}
              type="button"
              variant="outline"
              className="h-11 min-w-0 flex-1 justify-between gap-2 font-normal"
              disabled={cannotEdit}
              onClick={(event) => {
                opener.current = event.currentTarget
                setOpen(index)
              }}
            >
              <span className="truncate">{fullModel(fallback)}</span>
              <ChevronDownIcon className="shrink-0 text-muted-foreground" />
            </Button>
            <Button
              type="button"
              variant="ghost"
              size="icon-lg"
              className="size-11 shrink-0"
              aria-label={`Remove fallback ${index + 1}`}
              disabled={saving}
              onClick={() => reportWrite(save(withFallback(list, index, undefined)))}
            >
              <XIcon />
            </Button>
          </div>
        ))}
        {list.length < MAX_FALLBACKS && (
          <Button
            type="button"
            variant="outline"
            className="h-11 w-full gap-1.5 font-normal"
            disabled={cannotEdit}
            onClick={(event) => {
              opener.current = event.currentTarget
              setOpen(list.length)
            }}
          >
            <PlusIcon />
            Add fallback
          </Button>
        )}
      </div>
      <Popup
        open={open !== undefined}
        onOpenChange={(next) => !next && setOpen(undefined)}
        anchor={opener}
      >
        <PopupContent initialFocus={false} fixedHeight={PICKER_HEIGHT}>
          <ModelPicker
            providers={providers}
            fallback={{ label: "None" }}
            recent={profile.recentModels}
            choice={chosen}
            onChoose={(next) => {
              // Picking None on a row drops that fallback; on the add row it is nothing to add, so
              // nothing is written either.
              if (open !== undefined && (next !== undefined || open < list.length)) {
                reportWrite(save(withFallback(list, open, next)))
              }
              if (next) void rememberModel(profile.id, next)
              setOpen(undefined)
            }}
          />
        </PopupContent>
      </Popup>
    </Field>
  )
}

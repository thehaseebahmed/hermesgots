import { useState, type ReactNode } from "react"
import { useLiveQuery } from "dexie-react-hooks"
import { CheckIcon, PlusIcon, XIcon } from "lucide-react"
import { useNavigate } from "react-router"

import { Banner } from "@/components/banner"
import {
  Caption,
  Group,
  ModelPick,
  PickList,
  PickSurface,
  SwitchRow,
  ValueRow,
} from "@/components/settings-chrome"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Textarea } from "@/components/ui/textarea"
import { botSubPath, type BotSub } from "@/lib/bot-subs"
import { botTabPath } from "@/lib/bot-tabs"
import { getSettings, updateProfile, type Profile } from "@/lib/db"
import { useSpeech } from "@/lib/host-speech"
import { botModel, fullModel, useModelInfo } from "@/lib/model-info"
import {
  CLEANUP_LEVEL_ROWS,
  heardLine,
  levelName,
  marked,
  modelSize,
  modelSpeed,
  type CleanupLevel,
  type SpeechModel,
  type SpeechSettings,
} from "@/lib/speech"
import {
  effective,
  explicitly,
  modelOptions,
  parseNumber,
  providerLabel,
  providerLine,
  providerNote,
  providerPage,
  providerRows,
  rowOn,
  rowValue,
  sttGroups,
  type SttGroup,
  type SttSetting,
  type SttSettings,
  type SttValue,
} from "@/lib/stt-settings"
import { useWide } from "@/lib/media"
import { usePopupForm } from "@/lib/popup-form"
import { plural } from "@/lib/tools"
import { cn } from "@/lib/utils"
import { MAX_WORD, addWord, cleanWord, readVocabulary, removeWord } from "@/lib/vocabulary"

/**
 * The Speech-to-text page: the words this bot's speech leans towards and the model that tidies a
 * take, both Gots's own, over the bot's own Hermes — the model that hears it, and every setting
 * that decides what a take returns, mirrored from the Dashboard's form one key at a time
 * (ADR 0063). Every row is a value that opens its pick, its form or its page (ADR 0055).
 */
export function DictationTab({ profile, sub }: { profile: Profile; sub?: BotSub }) {
  const speech = useSpeech(profile)
  const settings = speech.supported ? speech.settings : undefined
  const block = speech.stt ? settings?.stt : undefined
  const navigate = useNavigate()
  const words = readVocabulary(profile.vocabulary)
  const info = useModelInfo(profile)
  const own = botModel(profile, info)
  const [pick, setPick] = useState<"speech" | "cleanup" | "level">()
  // The row whose form is open, wherever it sits on the page: one surface serves them all.
  const [open, setOpen] = useState<SttSetting>()
  const models = settings ? modelsFor(settings, block) : []
  const otherProviders = block ? providerRows(block) : []
  const heard = settings ? heardLine(settings.provider) : null
  // The Hearing prompt's value is the bot's, on the host, however many devices write it.
  const developer = useLiveQuery(async () => Boolean((await getSettings()).developer), [])

  // A detail takes the page's place at either width: below 1024px the route pushed it, and from
  // 1024px it is the pane the page would have drawn in. A provider's page is asked for first, since
  // it is the one detail whose address is two segments deep.
  if (sub?.item)
    return (
      <ProviderPage
        block={block}
        speech={speech}
        name={sub.item}
        back={botTabPath(profile.id, "speech-to-text")}
      />
    )
  if (sub?.id === "vocabulary") return <VocabularyPage profile={profile} words={words} />

  return (
    <div className="flex flex-col gap-4" data-bot-dictation>
      {/* One notice for every write: the host's own sentence, at the page's head. */}
      {speech.problem && (
        <Banner tone="error">
          <span role="alert">{speech.problem}</span>
        </Banner>
      )}

      {/* A host that carries only the model draws the page it always had — no captions to name
          groups it doesn't have, the two Gots rows marked where they sit. */}
      {!block && (
        <Group>
          <SpeechModelRow
            model={settings?.model ?? ""}
            disabled={!settings || !models.length}
            onClick={() => setPick("speech")}
          />
          <VocabularyRow profile={profile} words={words} />
        </Group>
      )}

      {/* Every setting the host carries, in cards named for what they are about (ADR 0063). */}
      {settings && block && (
        <SpeechGroups
          block={block}
          settings={settings}
          models={models}
          saving={speech.saving}
          onWrite={speech.writeStt}
          onOpen={setOpen}
          onPick={setPick}
          profile={profile}
          words={words}
        />
      )}

      {/* Where a take goes, where it isn't heard on this host (ADR 0069). */}
      {settings && heard && (
        <Group>
          <ValueRow
            title="Heard by"
            purpose={heard}
            value={providerLabel(settings.provider?.name ?? "")}
            muted
            data-setting="heard-by"
          />
        </Group>
      )}

      {block && otherProviders.length > 0 && (
        <Card id="providers" title="Providers">
          <Group>
            {otherProviders.map((row) => (
              <ValueRow
                key={row.name}
                title={row.label}
                purpose={row.model || undefined}
                value={providerNote(row) ?? undefined}
                muted={!row.inUse}
                onClick={() =>
                  navigate(botSubPath(profile.id, "speech-to-text", "providers", row.name))
                }
                data-setting={`providers-${row.name}`}
              />
            ))}
          </Group>
        </Card>
      )}

      {/* The cleanup's own card after the host's: its model, and — where the plugin takes them — the
          level a take is tidied at and, for a Developer, the Hearing prompt of its decode. */}
      {settings && (
        <CleanupSection
          settings={settings}
          saving={speech.saving}
          levels={speech.levels}
          hearing={speech.hearing}
          developer={Boolean(developer)}
          onLevel={() => setPick("level")}
          onHearing={(sent) => (speech.saving ? undefined : void speech.setHearing(sent))}
          onPick={() => setPick("cleanup")}
        />
      )}

      {block && (
        <SettingSurface
          block={block}
          row={open}
          saving={speech.saving}
          onWrite={speech.writeStt}
          onClose={() => setOpen(undefined)}
        />
      )}

      {settings && (
        <PickSurface
          open={pick === "speech"}
          onOpenChange={(open) => !open && setPick(undefined)}
          title="Speech model"
        >
          <PickList
            label="Speech models"
            searchable={false}
            selected={settings.model}
            options={modelsFor(settings, block).map((row) => ({
              id: row.name,
              label: row.name,
              detail: modelNotes(row),
            }))}
            onPick={(name) => {
              if (name !== settings.model) void speech.choose(name)
              setPick(undefined)
            }}
          />
        </PickSurface>
      )}

      {settings && (
        <PickSurface
          open={pick === "level"}
          onOpenChange={(open) => !open && setPick(undefined)}
          title="Cleanup level"
        >
          <LevelPick
            level={settings.cleanup.level}
            saving={speech.saving}
            onPick={(level) => {
              if (!speech.saving) void speech.chooseLevel(level)
              setPick(undefined)
            }}
          />
        </PickSurface>
      )}

      {settings && (
        <ModelPick
          open={pick === "cleanup"}
          title="Cleanup model"
          profile={profile}
          choice={settings.cleanup.model ?? undefined}
          fallback={{ label: "Default", model: own?.model }}
          onPick={(next) => (speech.saving ? undefined : void speech.chooseCleanup(next ?? null))}
          onClose={() => setPick(undefined)}
        />
      )}
    </div>
  )
}

/** What every card of the host's settings is drawn with: the page's one write, one surface, three picks. */
type CardProps = {
  block: SttSettings
  settings: SpeechSettings
  models: SpeechModel[]
  saving: boolean
  onWrite: (key: string, value: SttValue) => Promise<boolean>
  onOpen: (row: SttSetting) => void
  onPick: (pick: "speech" | "cleanup") => void
  profile: Profile
  words: string[]
}

/** One card of the page: the muted caption naming what it holds, over the rows it holds. */
function Card({ id, title, children }: { id: string; title: string; children: ReactNode }) {
  return (
    <section className="flex flex-col gap-2" data-stt-group={id}>
      <Caption>{title}</Caption>
      {children}
    </section>
  )
}

/**
 * The host's settings as the page draws them: one card per group, captioned by what the settings
 * are about, with the two Gots rows in the card their kin live in and a tag saying whose they are.
 * Every row but the speech model writes its own key through `onWrite`.
 */
function SpeechGroups(props: CardProps) {
  return (
    <>
      {sttGroups().map((group) => (
        <Card key={group.id} id={group.id} title={group.title}>
          <Group>
            <GroupRows {...props} group={group.id} rows={group.rows} />
          </Group>
        </Card>
      ))}
    </>
  )
}

/**
 * One card's rows, with the Gots row in place: Vocabulary sits under the initial prompt it rides
 * into the decoder with.
 */
function GroupRows({
  group,
  rows,
  ...props
}: CardProps & { group: SttGroup; rows: readonly SttSetting[] }) {
  const { block, settings, models, saving, onWrite, onOpen, onPick, profile, words } = props
  // Vocabulary goes where the prompt it is appended after sits, and nowhere else.
  const after = rows.findIndex((row) => row.key === "stt.local.initial_prompt") + 1
  const cut = group === "local" && after > 0 ? after : rows.length
  const draw = (one: SttSetting) =>
    one.key === "stt.local.model" ? (
      <SpeechModelRow
        key={one.key}
        model={settings.model}
        disabled={!models.length}
        onClick={() => onPick("speech")}
      />
    ) : one.key === "stt.provider" ? (
      <ProviderRow key={one.key} row={one} block={block} saving={saving} onOpen={onOpen} />
    ) : (
      <HostRow
        key={one.key}
        row={one}
        block={block}
        saving={saving}
        onWrite={onWrite}
        onOpen={onOpen}
      />
    )
  return (
    <>
      {rows.slice(0, cut).map(draw)}
      {group === "local" && <VocabularyRow profile={profile} words={words} />}
      {rows.slice(cut).map(draw)}
    </>
  )
}

/** The pick that decides who hears: its value says what Hermes resolved, or that it decides. */
function ProviderRow({
  row,
  block,
  saving,
  onOpen,
}: {
  row: SttSetting
  block: SttSettings
  saving: boolean
  onOpen: (row: SttSetting) => void
}) {
  const line = providerLine(block)
  return (
    <ValueRow
      title={row.label}
      purpose={line.note ?? row.purpose}
      value={line.value}
      muted={line.muted}
      busy={saving}
      onClick={() => onOpen(row)}
      data-setting={row.key}
    />
  )
}

/**
 * One of the host's rows, drawn by what it holds: a switch writes on its own and a value opens its
 * form, and a reset writes `null`, so the key leaves the file and Hermes's default takes over.
 */
function HostRow({
  row,
  block,
  saving,
  onWrite,
  onOpen,
}: {
  row: SttSetting
  block: SttSettings
  saving: boolean
  onWrite: (key: string, value: SttValue) => Promise<boolean>
  onOpen: (row: SttSetting) => void
}) {
  return row.control === "switch" ? (
    <SwitchRow
      id={`stt-${row.key}`}
      title={row.label}
      checked={rowOn(block, row.key)}
      disabled={saving}
      onCheckedChange={(next) => void onWrite(row.key, next)}
      data-setting={row.key}
    />
  ) : (
    <ValueRow
      title={row.label}
      purpose={row.purpose}
      value={rowValue(block, row.key)}
      muted={!explicitly(block, row.key)}
      busy={saving}
      onClick={() => onOpen(row)}
      data-setting={row.key}
    />
  )
}

/**
 * One table of settings as rows, with the surface they share: a provider's page draws its own rows
 * through here, which is the page's rule over a different list.
 */
function SettingRows({
  rows,
  block,
  saving,
  onWrite,
  open,
  setOpen,
}: {
  rows: readonly SttSetting[]
  block: SttSettings
  saving: boolean
  onWrite: (key: string, value: SttValue) => Promise<boolean>
  open: SttSetting | undefined
  setOpen: (row: SttSetting | undefined) => void
}) {
  return (
    <>
      {rows.map((row) => (
        <HostRow
          key={row.key}
          row={row}
          block={block}
          saving={saving}
          onWrite={onWrite}
          onOpen={setOpen}
        />
      ))}
      <SettingSurface
        block={block}
        row={open}
        saving={saving}
        onWrite={onWrite}
        onClose={() => setOpen(undefined)}
      />
    </>
  )
}

/** The speech model's own row: the model the host has in play, opening the models it offers. */
function SpeechModelRow({
  model,
  disabled,
  onClick,
}: {
  model: string
  disabled: boolean
  onClick: () => void
}) {
  return (
    <ValueRow
      title="Speech model"
      purpose="The model that hears this bot's speech-to-text"
      value={model}
      disabled={disabled}
      onClick={onClick}
      data-setting="speech-model"
    />
  )
}

/** The models a pick offers: the host's own list, kept to the names it declares (ADR 0063). */
function modelsFor(settings: SpeechSettings, block?: SttSettings): SpeechModel[] {
  if (!block) return settings.models
  return modelOptions(settings.models, block.models.local ?? [], settings.model)
}

/** Whatever changes one setting: a pick over a closed set, or the form a value is typed in. */
function SettingSurface({
  block,
  row,
  saving,
  onWrite,
  onClose,
}: {
  block: SttSettings
  row: SttSetting | undefined
  saving: boolean
  onWrite: (key: string, value: SttValue) => Promise<boolean>
  onClose: () => void
}) {
  const pick = row?.control === "pick"
  return (
    <>
      <PickSurface
        open={Boolean(pick && row)}
        onOpenChange={(open) => !open && onClose()}
        title={row?.label ?? ""}
      >
        {row && pick && (
          <PickList
            label={row.label}
            searchable={false}
            selected={pickedFor(block, row)}
            options={optionsFor(block, row)}
            onPick={(id) => {
              void onWrite(row.key, id ? id : null).then((ok) => {
                if (ok) onClose()
              })
            }}
          />
        )}
      </PickSurface>
      {row && !pick && (
        <ValueForm
          key={row.key}
          block={block}
          row={row}
          saving={saving}
          onWrite={onWrite}
          onClose={onClose}
        />
      )}
    </>
  )
}

/** What a pick marks as chosen: the pick the file holds, else what the host would use. */
function pickedFor(block: SttSettings, row: SttSetting): string {
  if (row.key === "stt.provider") return block.provider.explicit ?? ""
  const value = effective(block, row.key)
  return value === null ? "" : String(value)
}

/** The choices a pick offers: the providers, a provider's models, or nothing where it has none. */
function optionsFor(
  block: SttSettings,
  row: SttSetting,
): { id: string; label: string; detail?: string }[] {
  if (row.key === "stt.provider")
    return [
      {
        id: "",
        label: "Automatic",
        detail:
          block.provider.name && block.provider.name !== "none"
            ? providerLabel(block.provider.name)
            : (block.provider.reason ?? undefined),
      },
      ...block.providers.map((one) => ({
        id: one.name,
        label: providerLabel(one.name),
        detail:
          providerNote({ inUse: one.name === block.provider.name, keySet: one.keySet }) ??
          undefined,
      })),
    ]
  const provider = row.key.split(".")[1]
  return (block.models[provider] ?? []).map((name) => ({ id: name, label: name }))
}

/**
 * A setting typed in by hand: its value, the host's default as the placeholder, and a reset where
 * the file holds a value — which writes `null`, so the key leaves the file. A number that isn't
 * one is refused here, before anything is written; nothing else is refused, since Hermes declares
 * no bound on any of these (ADR 0063).
 */
function ValueForm({
  block,
  row,
  saving,
  onWrite,
  onClose,
}: {
  block: SttSettings
  row: SttSetting
  saving: boolean
  onWrite: (key: string, value: SttValue) => Promise<boolean>
  onClose: () => void
}) {
  const current = effective(block, row.key)
  const written = explicitly(block, row.key)
  const [draft, setDraft] = useState(current === null ? "" : String(current))
  const number = row.control === "number"
  const parsed = number ? parseNumber(draft) : undefined
  const value: SttValue | undefined = number
    ? parsed?.ok
      ? parsed.value
      : undefined
    : draft.trim()
      ? draft
      : null
  const same = value !== undefined && String(value ?? "") === String(current ?? "")
  const ready = value !== undefined && !same && !saving
  const id = `stt-${row.key}`

  return (
    <PickSurface open onOpenChange={(next) => !next && onClose()} title={row.label}>
      <form
        className="flex flex-col gap-4"
        onSubmit={(event) => {
          event.preventDefault()
          if (!ready) return
          void onWrite(row.key, value).then((ok) => {
            if (ok) onClose()
          })
        }}
      >
        <div className="flex flex-col gap-2">
          <Label htmlFor={id}>{row.label}</Label>
          {row.control === "multiline" ? (
            <Textarea
              id={id}
              rows={3}
              autoCapitalize="off"
              spellCheck={false}
              placeholder={String(block.defaults[row.key] ?? "")}
              value={draft}
              onChange={(event) => setDraft(event.target.value)}
            />
          ) : (
            <Input
              id={id}
              className="h-11"
              autoComplete="off"
              autoCapitalize="off"
              spellCheck={false}
              inputMode={number ? "decimal" : undefined}
              placeholder={String(block.defaults[row.key] ?? "")}
              value={draft}
              onChange={(event) => setDraft(event.target.value)}
            />
          )}
        </div>
        <div className="flex flex-col-reverse gap-2 sm:flex-row sm:items-center sm:justify-end">
          {written && (
            <Button
              type="button"
              variant="ghost"
              className="text-muted-foreground sm:mr-auto"
              disabled={saving}
              onClick={() => void onWrite(row.key, null).then((ok) => ok && onClose())}
            >
              Host default
            </Button>
          )}
          <Button type="button" variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" disabled={!ready}>
            Save
          </Button>
        </div>
      </form>
    </PickSurface>
  )
}

/** One provider's own settings: its model, its language, and the few knobs it alone has. */
function ProviderPage({
  block,
  speech,
  name,
  back,
}: {
  block: SttSettings | undefined
  speech: ReturnType<typeof useSpeech>
  name: string
  back: string
}) {
  const navigate = useNavigate()
  const [open, setOpen] = useState<SttSetting>()
  const rows = providerPage(name)
  // A provider this host doesn't declare, or DeepInfra before it has said which models it can hear
  // with: the address is reachable by hand, so it says which of those it is.
  const declared = block?.providers.some((one) => one.name === name) ?? false
  return (
    <div className="flex flex-col gap-4" data-stt-provider={name}>
      <Group>
        {block && rows.length ? (
          <SettingRows
            rows={rows}
            block={block}
            saving={speech.saving}
            onWrite={speech.writeStt}
            open={open}
            setOpen={setOpen}
          />
        ) : (
          <p className="px-5 py-3.5 text-sm text-muted-foreground">
            {!declared
              ? "This host doesn't declare this provider."
              : name === "deepinfra"
                ? "This host hasn't reported the models DeepInfra can hear with."
                : "This app doesn't draw this provider's settings yet."}
          </p>
        )}
      </Group>
      <Done onClick={() => navigate(back)} />
    </div>
  )
}

/** The footer a drill-in page closes with. */
function Done({ onClick }: { onClick: () => void }) {
  return (
    <Button variant="ghost" className="self-start text-muted-foreground" onClick={onClick}>
      Done
    </Button>
  )
}

/** The words this bot's speech leans towards: a drill-in list, marked as Gots's own. */
function VocabularyRow({ profile, words }: { profile: Profile; words: string[] }) {
  const navigate = useNavigate()
  return (
    <ValueRow
      title="Vocabulary"
      tag="Gots"
      purpose="The words this bot's speech leans towards"
      value={words.length ? plural(words.length, "word", "words") : ""}
      onClick={() => navigate(botSubPath(profile.id, "speech-to-text", "vocabulary"))}
      data-setting="vocabulary"
    />
  )
}

/** The cleanup model's row: its value, or why this host won't let Gots pick it. */
function CleanupRow({
  tag,
  settings,
  saving,
  onClick,
}: {
  tag?: string
  settings: SpeechSettings | undefined
  saving: boolean
  onClick: () => void
}) {
  const pick = settings?.cleanup.model
  // A host that won't say which model tidies a take can't be offered the pick, and one that never
  // answered the read at all is drawn the same way: disabled, with whatever it said.
  if (!settings?.cleanup.allowed)
    return (
      <ValueRow
        title="Cleanup model"
        tag={tag}
        purpose={settings?.cleanup.reason ?? "This host doesn't let Gots pick the model."}
        value="Default"
        disabled
        data-setting="cleanup-model"
      />
    )
  return (
    <ValueRow
      title="Cleanup model"
      tag={tag}
      purpose="The model that tidies a take's finished words"
      value={pick ? fullModel(pick) : "Default"}
      disabled={saving}
      onClick={onClick}
      data-setting="cleanup-model"
    />
  )
}

/** The cleanup's card: the level a take is tidied at, its model, and the decode's prompt. */
function CleanupSection({
  settings,
  saving,
  levels,
  hearing,
  developer,
  onLevel,
  onHearing,
  onPick,
}: {
  settings: SpeechSettings
  saving: boolean
  levels: boolean
  hearing: boolean
  developer: boolean
  onLevel: () => void
  onHearing: (sent: boolean) => void
  onPick: () => void
}) {
  return (
    <Card id="cleanup" title="Cleanup">
      <Group>
        {levels && (
          <ValueRow
            title="Cleanup level"
            tag="Gots"
            purpose="How much the tidying changes in a take"
            value={levelName(settings.cleanup.level)}
            disabled={saving}
            onClick={onLevel}
            data-setting="cleanup-level"
          />
        )}
        <CleanupRow tag="Gots" settings={settings} saving={saving} onClick={onPick} />
        {hearing && developer && (
          <SwitchRow
            id="stt-hearing-prompt"
            title="Hearing prompt"
            subtitle="Whether the speech model is told this bot's names before it listens"
            checked={settings.hearing.sent}
            disabled={saving}
            onCheckedChange={onHearing}
            data-setting="hearing-prompt"
          />
        )}
      </Group>
    </Card>
  )
}

/** The four levels as the sheet lists them: one setting card each, chosen one marked (ADR 0066). */
function LevelPick({
  level,
  saving,
  onPick,
}: {
  level: CleanupLevel
  saving: boolean
  onPick: (level: CleanupLevel) => void
}) {
  const form = usePopupForm()
  const wide = useWide()
  return (
    <div
      className={cn(
        "flex min-h-0 flex-col gap-1.5 overflow-y-auto",
        // Two across in the tablet's sheet, where there is the room to compare them; one column on a
        // phone and in the desktop's drawer, which is a third of the screen wide.
        form === "sheet" && wide && "grid auto-rows-fr grid-cols-2",
      )}
      data-cleanup-levels
    >
      {CLEANUP_LEVEL_ROWS.map((row) => {
        const chosen = row.level === level
        return (
          <button
            key={row.level}
            type="button"
            aria-pressed={chosen}
            disabled={saving}
            onClick={() => onPick(row.level)}
            data-cleanup-level={row.level}
            className={cn(
              "flex h-full flex-col gap-1.5 rounded-xl border p-3 text-left transition-colors",
              chosen ? "border-ring bg-card" : "border-border bg-card hover:bg-muted/40",
            )}
          >
            <span className="flex items-center gap-2">
              <span className="text-base">{row.name}</span>
              {chosen && <CheckIcon className="size-4 shrink-0 text-primary" aria-hidden />}
            </span>
            <span className="text-sm text-muted-foreground">{row.purpose}</span>
            <span className="flex-1 rounded-lg bg-muted px-3 py-2 text-xs leading-snug text-muted-foreground">
              {row.sample}
            </span>
          </button>
        )
      })}
    </div>
  )
}

/** The words this bot's speech leans towards: the list, with removing and adding in it. */
function VocabularyPage({ profile, words }: { profile: Profile; words: string[] }) {
  const [draft, setDraft] = useState("")
  const navigate = useNavigate()
  const save = (next: string[]) => void updateProfile(profile.id, { vocabulary: next })
  const ready = Boolean(cleanWord(draft))

  return (
    <div className="flex flex-col gap-4" data-vocabulary>
      <Group>
        {words.map((word) => (
          <div key={word} className="flex items-center gap-1 bg-card">
            <span className="min-w-0 flex-1 truncate px-5 py-3.5 text-base">{word}</span>
            <Button
              type="button"
              variant="ghost"
              size="icon-lg"
              className="mr-3 size-11 shrink-0"
              aria-label={`Remove ${word}`}
              onClick={() => save(removeWord(words, word))}
            >
              <XIcon />
            </Button>
          </div>
        ))}
        {!words.length && (
          <p className="px-5 py-3.5 text-sm text-muted-foreground">No words yet.</p>
        )}
      </Group>

      {/* Adding is the one field here, and it lives on the screen itself, not inside a card. */}
      <form
        className="flex gap-2"
        onSubmit={(event) => {
          event.preventDefault()
          if (!ready) return
          save(addWord(words, draft))
          setDraft("")
        }}
      >
        <Input
          id="vocabulary-word"
          className="h-11"
          aria-label="Add a word"
          autoComplete="off"
          autoCapitalize="off"
          spellCheck={false}
          enterKeyHint="done"
          maxLength={MAX_WORD}
          placeholder="A name or a word"
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
        />
        <Button type="submit" variant="outline" className="h-11" disabled={!ready}>
          <PlusIcon data-icon="inline-start" />
          Add
        </Button>
      </form>

      <Done onClick={() => navigate(botTabPath(profile.id, "speech-to-text"))} />
    </div>
  )
}

/** A model's one muted line: what it weighs, how fast it hears, and whether it is already at work. */
function modelNotes(row: SpeechModel): string {
  const download = row.downloaded || row.inUse ? "" : "Not on this host"
  return [modelSize(row.sizeMb), modelSpeed(row.speed), marked(row), download]
    .filter(Boolean)
    .join(" · ")
}

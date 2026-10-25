import { CheckIcon, ChevronDownIcon, XIcon } from "lucide-react"
import { useRef, useState } from "react"

import { Banner } from "@/components/banner"
import { ModelPicker } from "@/components/chat/model-picker"
import { Popup, PopupContent, PopupHeader, PopupTitle } from "@/components/popup"
import { Group, GroupHeading } from "@/components/settings-chrome"
import { Button } from "@/components/ui/button"
import { Field, FieldDescription, FieldLabel } from "@/components/ui/field"
import { Input } from "@/components/ui/input"
import { updateProfile, type Profile } from "@/lib/db"
import { useSpeech } from "@/lib/host-speech"
import { botModel, fullModel, useModelInfo } from "@/lib/model-info"
import {
  marked,
  modelSize,
  modelSpeed,
  type SpeechModel,
  type SpeechPick,
  type SpeechSettings,
} from "@/lib/speech"
import { cn } from "@/lib/utils"
import { MAX_WORD, addWord, cleanWord, readVocabulary, removeWord } from "@/lib/vocabulary"

/**
 * The Speech-to-text page: the words this bot's speech leans towards and the model that tidies a
 * take, both Gots's own, over the model on the bot's host that hears it — the one setting here the
 * bot's Hermes owns, so the page wears both ownership headings.
 */
export function DictationTab({ profile }: { profile: Profile }) {
  const [draft, setDraft] = useState("")
  const words = readVocabulary(profile.vocabulary)
  const save = (next: string[]) => void updateProfile(profile.id, { vocabulary: next })
  const ready = Boolean(cleanWord(draft))
  const speech = useSpeech(profile)
  const settings = speech.supported ? speech.settings : undefined

  const add = () => {
    if (!ready) return
    save(addWord(words, draft))
    setDraft("")
  }

  return (
    <div className="flex flex-col gap-4" data-bot-dictation>
      {/* One notice for either group's writes: the host's own sentence, at the page's head. */}
      {speech.problem && (
        <Banner tone="error">
          <span role="alert">{speech.problem}</span>
        </Banner>
      )}
      <section className="flex flex-col gap-4" data-bot-group="gots">
        <GroupHeading title="Gots Specific Settings" />
        <Group>
          <Field className="bg-card px-5 py-4">
            <FieldLabel htmlFor="vocabulary-word">Vocabulary</FieldLabel>
            <FieldDescription>The words this bot's speech leans towards</FieldDescription>
            <form
              className="flex gap-2"
              onSubmit={(event) => {
                event.preventDefault()
                add()
              }}
            >
              <Input
                id="vocabulary-word"
                className="h-11"
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
                Add
              </Button>
            </form>
            {words.length > 0 && (
              <ul className="flex flex-wrap gap-2" aria-label="Words">
                {words.map((word) => (
                  <li key={word}>
                    <span className="flex h-9 items-center gap-1 rounded-full bg-muted pr-0.5 pl-3 text-sm">
                      <span className="max-w-56 truncate">{word}</span>
                      {/* The inset widens the 36px button's hit area to the 44px the floor asks for. */}
                      <button
                        type="button"
                        onClick={() => save(removeWord(words, word))}
                        aria-label={`Remove ${word}`}
                        className="relative flex size-9 items-center justify-center rounded-full text-muted-foreground outline-none after:absolute after:-inset-1 hover:bg-background hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
                      >
                        <XIcon className="size-4" />
                      </button>
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </Field>
          {settings && (
            <CleanupModelField
              profile={profile}
              settings={settings}
              saving={speech.saving}
              onChoose={speech.chooseCleanup}
            />
          )}
        </Group>
      </section>
      {settings && (
        <section className="flex flex-col gap-4" data-bot-group="hermes">
          <GroupHeading title="Hermes Settings" />
          <Group>
            <SpeechModelField
              settings={settings}
              saving={speech.saving}
              onChoose={speech.choose}
            />
          </Group>
        </section>
      )}
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

/**
 * The host's own speech models, picked as the composer picks a chat's model: one field naming the
 * model in play, opening the list. A bot always has one hearing it, so there is no clear entry, no
 * search over a list this short, and no recents.
 */
function SpeechModelField({
  settings,
  saving,
  onChoose,
}: {
  settings: SpeechSettings
  saving: boolean
  onChoose: (model: string) => Promise<boolean>
}) {
  const [open, setOpen] = useState(false)
  const field = useRef<HTMLButtonElement>(null)
  const current = settings.models.find((row) => row.name === settings.model)
  const name = settings.model || current?.name || ""

  return (
    <Field
      aria-labelledby="speech-model-label"
      aria-busy={saving || undefined}
      className="bg-card px-5 py-4"
    >
      <FieldLabel id="speech-model-label">Speech model</FieldLabel>
      <FieldDescription>The model that hears this bot's speech-to-text</FieldDescription>
      <Button
        ref={field}
        id="speech-model"
        type="button"
        variant="outline"
        aria-label={`Speech model: ${name || "none"}`}
        className="h-11 w-full justify-between gap-2 font-normal"
        disabled={saving || !settings.models.length}
        onClick={() => setOpen(true)}
      >
        <span className="truncate">{name || "Not set"}</span>
        <span className="flex shrink-0 items-center gap-2">
          {current && (
            <span className="hidden truncate text-sm text-muted-foreground sm:inline">
              {modelNotes(current)}
            </span>
          )}
          <ChevronDownIcon className="size-4 shrink-0 text-muted-foreground" aria-hidden />
        </span>
      </Button>
      <Popup open={open} onOpenChange={setOpen} anchor={field}>
        <PopupContent initialFocus={false}>
          <PopupHeader>
            <PopupTitle>Speech model</PopupTitle>
          </PopupHeader>
          <ul aria-label="Speech models" className="flex flex-col rounded-2xl bg-muted/60 p-1">
            {settings.models.map((row) => {
              const chosen = row.name === settings.model
              return (
                <li key={row.name}>
                  <button
                    type="button"
                    aria-pressed={chosen}
                    disabled={saving}
                    onClick={() => {
                      // The model already hearing it is no write, only a pick already made.
                      if (!chosen) void onChoose(row.name)
                      setOpen(false)
                    }}
                    className={cn(
                      "flex min-h-11 w-full items-center gap-3 rounded-xl px-3 py-2 text-left transition-colors hover:bg-background/60 focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:outline-none disabled:opacity-60",
                      chosen && "bg-background",
                    )}
                  >
                    <span className="flex min-w-0 flex-1 flex-col">
                      <span className="break-all">{row.name}</span>
                      <span className="truncate text-sm text-muted-foreground">
                        {modelNotes(row)}
                      </span>
                    </span>
                    {chosen && <CheckIcon className="size-4 shrink-0 text-primary" aria-hidden />}
                  </button>
                </li>
              )
            })}
          </ul>
        </PopupContent>
      </Popup>
    </Field>
  )
}

function CleanupModelField({
  profile,
  settings,
  saving,
  onChoose,
}: {
  profile: Profile
  settings: SpeechSettings
  saving: boolean
  onChoose: (model: SpeechPick | null) => Promise<boolean>
}) {
  const [open, setOpen] = useState(false)
  const field = useRef<HTMLButtonElement>(null)
  const info = useModelInfo(profile)
  const providers = info?.providers ?? []
  const own = botModel(profile, info)
  const pick = settings.cleanup.model

  return (
    <Field
      aria-labelledby="cleanup-model-label"
      aria-busy={saving || undefined}
      className="bg-card px-5 py-4"
    >
      <FieldLabel id="cleanup-model-label">Cleanup model</FieldLabel>
      <FieldDescription>The model that tidies a take's finished words</FieldDescription>
      {!settings.cleanup.allowed ? (
        <Banner tone="warning">
          {settings.cleanup.reason ?? "This host doesn't let Gots pick the model."}
        </Banner>
      ) : (
        <>
          <Button
            ref={field}
            id="cleanup-model"
            type="button"
            variant="outline"
            aria-label={`Cleanup model: ${pick ? fullModel(pick) : "Default"}`}
            className="h-11 w-full justify-between gap-2 font-normal"
            disabled={!providers.length || saving}
            onClick={() => setOpen(true)}
          >
            <span className="truncate">{pick ? fullModel(pick) : "Default"}</span>
          </Button>
          <Popup open={open} onOpenChange={setOpen} anchor={field}>
            <PopupContent initialFocus={false}>
              <ModelPicker
                providers={providers}
                fallback={{ label: "Default", model: own?.model }}
                choice={pick ?? undefined}
                onChoose={(next) => {
                  void onChoose(next ?? null)
                  setOpen(false)
                }}
              />
            </PopupContent>
          </Popup>
        </>
      )}
    </Field>
  )
}

/**
 * A bot's Dictation settings, on the Dictation tab of its editor: the words its dictation is
 * written with, the host speech model that hears it, and the model a finished phrase is tidied on.
 *
 * The words are written straight into the bot's own record — the same record its name lives in,
 * which syncs last-write-wins — so the words taught on one device reach the others. A take reads the
 * list as it stands when the take starts, which is why a removal takes effect on the next one.
 *
 * The speech model is the host's, not the bot's (`GET` and `POST speech`): Hermes's
 * `stt.local.model`, chosen from the models the plugin lists with their size and speed. A pick that
 * isn't on the host downloads inside the next take, which waits for it the way a cold start does; a
 * pick that won't load falls back to the model that last did, and the host's warning is shown here.
 * Both land on the next take, never on one being spoken.
 *
 * The cleanup model is the bot's own line on this tab, kept on the host and read at the start of
 * every take. Where the host withholds the plugin's model-override permission the field is not
 * offered: the host would ignore it, and the notice says how to allow it.
 */
import { XIcon } from "lucide-react"
import { useRef, useState } from "react"

import { Banner } from "@/components/banner"
import { ModelPicker } from "@/components/chat/model-picker"
import { Popup, PopupContent } from "@/components/popup"
import { Button } from "@/components/ui/button"
import { Field, FieldGroup, FieldLabel } from "@/components/ui/field"
import { Input } from "@/components/ui/input"
import { updateProfile, type Profile } from "@/lib/db"
import { useSpeech } from "@/lib/host-speech"
import { botModel, fullModel, useModelInfo } from "@/lib/model-info"
import { marked, modelSize, modelSpeed, type SpeechPick, type SpeechSettings } from "@/lib/speech"
import { MAX_WORD, addWord, cleanWord, readVocabulary, removeWord } from "@/lib/vocabulary"

export function DictationTab({ profile }: { profile: Profile }) {
  const [draft, setDraft] = useState("")
  const words = readVocabulary(profile.vocabulary)
  const save = (next: string[]) => void updateProfile(profile.id, { vocabulary: next })
  const ready = Boolean(cleanWord(draft))
  const speech = useSpeech(profile)

  const add = () => {
    if (!ready) return
    save(addWord(words, draft))
    setDraft("")
  }

  return (
    <FieldGroup data-bot-dictation>
      <Field>
        <FieldLabel htmlFor="vocabulary-word">Word</FieldLabel>
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
      </Field>
      {words.length > 0 && (
        <ul className="flex flex-wrap gap-2" aria-label="Words">
          {words.map((word) => (
            <li key={word}>
              <span className="flex h-9 items-center gap-1 rounded-full bg-muted pr-0.5 pl-3 text-sm">
                <span className="max-w-56 truncate">{word}</span>
                {/* The chip is 36px; the button's hit area reaches 44px past it. */}
                <button
                  type="button"
                  onClick={() => save(removeWord(words, word))}
                  aria-label={`Remove ${word}`}
                  className="relative flex size-8 items-center justify-center rounded-full text-muted-foreground outline-none after:absolute after:-inset-1 hover:bg-background hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
                >
                  <XIcon className="size-4" />
                </button>
              </span>
            </li>
          ))}
        </ul>
      )}
      {speech.supported && speech.settings && (
        <>
          {/* One notice for either write: the host's own sentence, above both fields. */}
          {speech.problem && (
            <Banner tone="error">
              <span role="alert">{speech.problem}</span>
            </Banner>
          )}
          <SpeechModelField
            settings={speech.settings}
            saving={speech.saving}
            onChoose={speech.choose}
          />
          <CleanupModelField
            profile={profile}
            settings={speech.settings}
            saving={speech.saving}
            onChoose={speech.chooseCleanup}
          />
        </>
      )}
    </FieldGroup>
  )
}

/** The host's speech models: what each one costs to hear, and which is in play. */
function SpeechModelField({
  settings,
  saving,
  onChoose,
}: {
  settings: SpeechSettings
  saving: boolean
  onChoose: (model: string) => Promise<boolean>
}) {
  return (
    <Field aria-labelledby="speech-model-label" aria-busy={saving || undefined}>
      <FieldLabel id="speech-model-label">Speech model</FieldLabel>
      <p className="text-sm text-muted-foreground">
        What hears a dictation on this bot's host. A change lands on the next take.
      </p>
      {settings.warning && (
        <Banner tone="warning">
          {settings.warning.model} didn't load, so dictation is heard on {settings.model}:{" "}
          {settings.warning.reason}
        </Banner>
      )}
      <ul aria-label="Speech models" className="space-y-2">
        {settings.models.map((row) => (
          <li key={row.name}>
            <button
              type="button"
              aria-pressed={row.inUse}
              disabled={saving || row.inUse}
              onClick={() => void onChoose(row.name)}
              className="flex min-h-11 w-full items-center justify-between gap-3 rounded-2xl border border-border px-4 py-2 text-left outline-none hover:bg-muted disabled:opacity-60 focus-visible:ring-2 focus-visible:ring-ring aria-pressed:border-primary"
            >
              <span className="min-w-0">
                <span className="block truncate font-medium">{row.name}</span>
                <span className="block text-sm text-muted-foreground">
                  {[modelSize(row.sizeMb), modelSpeed(row.speed)].filter(Boolean).join(" · ")}
                </span>
              </span>
              <span className="shrink-0 text-right text-sm text-muted-foreground">
                {marked(row) && <span className="block">{marked(row)}</span>}
                {!row.downloaded && !row.inUse && <span className="block">Not on this host</span>}
              </span>
            </button>
          </li>
        ))}
      </ul>
    </Field>
  )
}

/**
 * The one-line model override for cleanup: the bot's own model unless something else is picked.
 * Where the host withholds the permission the field is replaced by the host's own explanation, so
 * the user is never offered a pick that would be ignored.
 */
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
    <Field aria-labelledby="cleanup-model-label" aria-busy={saving || undefined}>
      <FieldLabel id="cleanup-model-label">Cleanup model</FieldLabel>
      {!settings.cleanup.allowed ? (
        <Banner tone="warning">
          {settings.cleanup.reason ?? "This host doesn't let Gots pick the model."}
        </Banner>
      ) : (
        <>
          <p className="text-sm text-muted-foreground">
            The model a finished phrase is tidied on. Default uses the bot's own model.
          </p>
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

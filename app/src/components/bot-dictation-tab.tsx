import { useState } from "react"
import { PlusIcon, XIcon } from "lucide-react"
import { useNavigate } from "react-router"

import { Banner } from "@/components/banner"
import { ModelPicker } from "@/components/chat/model-picker"
import { Caption, Group, PickList, PickSurface, ValueRow } from "@/components/settings-chrome"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { botSubPath, type BotSub } from "@/lib/bot-subs"
import { botTabPath } from "@/lib/bot-tabs"
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
 * bot's Hermes owns, so the page wears both ownership captions. Every row is a value that opens its
 * pick or drills into its list (ADR 0055).
 */
export function DictationTab({ profile, sub }: { profile: Profile; sub?: BotSub }) {
  const speech = useSpeech(profile)
  const settings = speech.supported ? speech.settings : undefined
  const navigate = useNavigate()
  const words = readVocabulary(profile.vocabulary)
  const [pick, setPick] = useState<"speech" | "cleanup">()

  // A detail takes the page's place at either width: below 1024px the route pushed it, and from
  // 1024px it is the pane the page would have drawn in.
  if (sub?.kind === "detail" && sub.id === "vocabulary")
    return <VocabularyPage profile={profile} words={words} />
  if (sub) return null

  return (
    <div className="flex flex-col gap-4" data-bot-dictation>
      {/* One notice for either group's writes: the host's own sentence, at the page's head. */}
      {speech.problem && (
        <Banner tone="error">
          <span role="alert">{speech.problem}</span>
        </Banner>
      )}

      <Caption>Gots</Caption>
      <Group>
        <ValueRow
          title="Vocabulary"
          purpose="The words this bot's speech leans towards"
          value={words.length ? `${words.length} ${words.length === 1 ? "word" : "words"}` : ""}
          onClick={() => navigate(botSubPath(profile.id, "speech-to-text", "vocabulary"))}
          data-setting="vocabulary"
        />
        {settings && (
          <CleanupRow
            settings={settings}
            saving={speech.saving}
            onClick={() => setPick("cleanup")}
          />
        )}
      </Group>

      {settings && (
        <>
          <Caption>Hermes</Caption>
          <Group>
            <ValueRow
              title="Speech model"
              purpose="The model that hears this bot's speech-to-text"
              value={settings.model}
              disabled={!settings.models.length}
              onClick={() => setPick("speech")}
              data-setting="speech-model"
            />
          </Group>
        </>
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
            options={settings.models.map((row) => ({
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
          open={pick === "cleanup"}
          onOpenChange={(open) => !open && setPick(undefined)}
          title="Cleanup model"
        >
          <CleanupPicker
            profile={profile}
            settings={settings}
            saving={speech.saving}
            onChoose={speech.chooseCleanup}
            onDone={() => setPick(undefined)}
          />
        </PickSurface>
      )}
    </div>
  )
}

/** The cleanup model's row: its value, or why this host won't let Gots pick it. */
function CleanupRow({
  settings,
  saving,
  onClick,
}: {
  settings: SpeechSettings
  saving: boolean
  onClick: () => void
}) {
  const pick = settings.cleanup.model
  if (!settings.cleanup.allowed)
    return (
      <ValueRow
        title="Cleanup model"
        purpose={settings.cleanup.reason ?? "This host doesn't let Gots pick the model."}
        value="Default"
        disabled
        data-setting="cleanup-model"
      />
    )
  return (
    <ValueRow
      title="Cleanup model"
      purpose="The model that tidies a take's finished words"
      value={pick ? fullModel(pick) : "Default"}
      disabled={saving}
      onClick={onClick}
      data-setting="cleanup-model"
    />
  )
}

/** The host's models, in the same picker the composer uses, with "Default" at its head. */
function CleanupPicker({
  profile,
  settings,
  saving,
  onChoose,
  onDone,
}: {
  profile: Profile
  settings: SpeechSettings
  saving: boolean
  onChoose: (model: SpeechPick | null) => Promise<boolean>
  onDone: () => void
}) {
  const info = useModelInfo(profile)
  const providers = info?.providers ?? []
  const own = botModel(profile, info)
  if (!providers.length)
    return (
      <p className="px-1 py-2 text-sm text-muted-foreground">Couldn't read this bot's models.</p>
    )
  return (
    <ModelPicker
      header={false}
      providers={providers}
      fallback={{ label: "Default", model: own?.model }}
      choice={settings.cleanup.model ?? undefined}
      onChoose={(next) => {
        if (saving) return
        void onChoose(next ?? null)
        onDone()
      }}
    />
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

      <Button
        variant="ghost"
        className={cn("self-start text-muted-foreground")}
        onClick={() => navigate(botTabPath(profile.id, "speech-to-text"))}
      >
        Done
      </Button>
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

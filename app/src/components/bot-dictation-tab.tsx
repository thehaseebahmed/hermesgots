/**
 * A bot's Dictation settings, on the Dictation tab of its editor: the words its dictation is
 * written with.
 *
 * A change is written straight into the bot's own record — the same record its name lives in, which
 * syncs last-write-wins — so the words taught on one device reach the others. A take reads the list
 * as it stands when the take starts, which is why a removal takes effect on the next one.
 *
 * The host speech model picker is the other half of this screen (#295): it writes the host's speech
 * settings rather than the bot's, so it stands beside this list, not in it.
 */
import { XIcon } from "lucide-react"
import { useState } from "react"

import { Button } from "@/components/ui/button"
import { Field, FieldGroup, FieldLabel } from "@/components/ui/field"
import { Input } from "@/components/ui/input"
import { updateProfile, type Profile } from "@/lib/db"
import { MAX_WORD, addWord, cleanWord, readVocabulary, removeWord } from "@/lib/vocabulary"

export function DictationTab({ profile }: { profile: Profile }) {
  const [draft, setDraft] = useState("")
  const words = readVocabulary(profile.vocabulary)
  const save = (next: string[]) => void updateProfile(profile.id, { vocabulary: next })
  const ready = Boolean(cleanWord(draft))

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
    </FieldGroup>
  )
}

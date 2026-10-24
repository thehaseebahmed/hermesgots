/**
 * A project's Prompt, written: how its AFK work is carried out. Its own bottom sheet — the app's own
 * pop-up, so a drawer from a laptop's width — with the words in a field deep enough to read them in.
 * Done writes it and closes on the host's answer; the sheet's own way out leaves the words unwritten,
 * and a refused write is said by the caller, which is why the draft stays as typed.
 *
 * Where the account's library is offered — signed in, with the vault unlocked — the sheet's foot is
 * one row: the two library doors on the left, Choose from library (which copies an entry's words in
 * and writes them the way Done does — a pick is a copy, so the host clears a picked workflow as it
 * does for any Prompt) and Save to library (which keeps the words on screen under a name and tags),
 * with Done on the right, as the entry sheet's own foot draws its primary action. Without the
 * library this is the editor it always was, Done alone at the foot.
 *
 * Where the words this project holds were copied from an entry that has since been rewritten, the
 * sheet offers the entry's newer words as a line over the field: one button fills the writing
 * surface with them, which writes nothing until Done — and Done writes the words with the entry id
 * beside them, so the copy stays the entry's copy; typing anything after that is the user's own
 * words again and Done writes them alone (ADR 0043). The line shows only while the field still holds
 * exactly what the host does, so it can never take words the user is part-way through writing.
 */
import { useState } from "react"
import { toast } from "sonner"

import { Popup, PopupContent, PopupHeader, PopupTitle } from "@/components/popup"
import { PromptEntrySheet, PromptLibrarySheet } from "@/components/prompt-library-sheet"
import { Button } from "@/components/ui/button"
import { Textarea } from "@/components/ui/textarea"
import type { PromptWrite } from "@/lib/hermes"
import type { PromptDraft, PromptEntry } from "@/lib/prompt-library"
import { addPrompt, removePrompt, savePrompt, usePromptEntries } from "@/lib/prompt-library-store"
import { promptSourceState } from "@/lib/prompt-source"

export function PromptEditor({
  open,
  onOpenChange,
  prompt,
  promptId = null,
  onSave,
  library = false,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  prompt: string
  /** The entry this project's words were copied from, if the host records one: the offer of the
   * entry's newer words is drawn only against that id's own entry. */
  promptId?: string | null
  /**
   * Writes the words, and — where they were copied from the account's library — the entry they came
   * from beside them. Done hands over the words alone, which detaches the copy on the host; a pick
   * hands over both, so the row can tell a copy whose entry moves on from an original.
   */
  onSave: (draft: PromptWrite) => Promise<"saved" | "refused">
  /** The account's library is drawn here: signed in, with the vault open on this device. */
  library?: boolean
}) {
  const [text, setText] = useState(prompt)
  const [saving, setSaving] = useState(false)
  // The entry the field was filled from by the offer line, held for Done to write beside the words
  // — so an update keeps the copy a copy. Any typing is the user's own words again, which clears it.
  const [updateSource, setUpdateSource] = useState<string | null>(null)
  // Each open starts from the words the row holds rather than from the draft the last one left, and
  // the sheet stays the same instance so its way out still animates.
  const [wasOpen, setWasOpen] = useState(open)
  if (open !== wasOpen) {
    setWasOpen(open)
    if (open) {
      setText(prompt)
      setUpdateSource(null)
    }
  }

  const entries = usePromptEntries(library)
  const [choosing, setChoosing] = useState(false)
  // One entry sheet for both doors: a new entry saving the words on screen, or an entry being
  // renamed, rewritten or deleted.
  const [writing, setWriting] = useState<PromptEntry | "new" | null>(null)

  /**
   * One write at a time, said the same way wherever it's made: the sheet's own controls are out of
   * reach while it runs, and a failure is a toast with the sheet left exactly as it was — open, and
   * holding what the user typed. `fallback` is what a failure that isn't the host's own words reads
   * as.
   */
  const attempt = async (work: () => Promise<void>, fallback: string) => {
    setSaving(true)
    try {
      await work()
    } catch (failure) {
      toast.error(failure instanceof Error ? failure.message : fallback)
    } finally {
      setSaving(false)
    }
  }

  const submit = async () => {
    // Done on the words the row already holds is not a write: it would turn the host's default into
    // this project's own words, which nothing then reads as the default again.
    if (text === prompt) {
      onOpenChange(false)
      return
    }
    await attempt(async () => {
      // A field filled by the offer line writes the words with their entry, so the copy stands; the
      // user's own words — anything else — are written alone, which is what clears a copy.
      const draft = updateSource ? { text, source: updateSource } : { text }
      if ((await onSave(draft)) === "saved") onOpenChange(false)
    }, "Couldn't save that Prompt.")
  }

  /**
   * The entry whose words moved on, while the field still holds exactly what the host does: the one
   * state the offer line may fill, so it can never take words the user is part-way through writing.
   */
  const entry = promptId ? entries?.find((one) => one.id === promptId) : undefined
  const offered =
    entry !== undefined &&
    promptSourceState(promptId, prompt, entry) === "changed" &&
    text === prompt

  /**
   * A pick is one write of the entry's own words and its id, through the route Done writes: the host
   * answers with what it holds now — a Prompt that remembers the entry it came from, so no workflow —
   * and the sheet stays open on the copy, which Done then closes without a second write. Typing over
   * the copy afterwards is a plain write, which clears the source: the row never calls the user's own
   * words stale (ADR 0043).
   */
  const pick = async (entry: PromptEntry) => {
    setChoosing(false)
    setText(entry.body)
    await attempt(async () => {
      await onSave({ text: entry.body, source: entry.id })
    }, "Couldn't save that Prompt.")
  }

  const write = async (draft: PromptDraft) => {
    const editing = writing === "new" ? null : writing
    await attempt(async () => {
      if (!editing) {
        await addPrompt(draft)
      } else if (!(await savePrompt(editing.id, draft))) {
        // The entry was deleted on another device: nothing was written, so the sheet keeps the typed
        // draft and says the entry is gone rather than closing as if it had saved.
        toast.error("That Prompt is gone from the library.")
        return
      }
      setWriting(null)
    }, "Couldn't save that Prompt.")
  }

  const remove = async (entry: PromptEntry) => {
    await attempt(async () => {
      await removePrompt(entry.id)
      setWriting(null)
    }, "Couldn't delete that Prompt.")
  }

  return (
    <Popup open={open} onOpenChange={onOpenChange}>
      <PopupContent>
        <PopupHeader>
          <PopupTitle>Prompt</PopupTitle>
        </PopupHeader>
        <div className="flex min-h-0 flex-1 flex-col gap-3 px-4 pb-4 sm:px-6">
          {offered && entry && (
            <div
              className="flex items-center justify-between gap-2 rounded-2xl bg-muted px-3 py-2"
              data-prompt-update
            >
              <p className="text-sm text-muted-foreground">The library's entry has newer words.</p>
              <Button
                type="button"
                className="h-11 shrink-0 rounded-full px-4"
                disabled={saving}
                onClick={() => {
                  setText(entry.body)
                  setUpdateSource(entry.id)
                }}
              >
                Update
              </Button>
            </div>
          )}
          <Textarea
            aria-label="Prompt"
            placeholder="How this project's work is carried out"
            className="min-h-[38dvh] resize-none rounded-2xl px-4 py-3 text-base md:text-[15px]"
            value={text}
            onChange={(event) => {
              setText(event.target.value)
              setUpdateSource(null)
            }}
          />
          {library ? (
            <div className="flex items-center gap-1.5" data-prompt-library-actions>
              <Button
                type="button"
                variant="secondary"
                className="h-11 rounded-full px-3"
                disabled={saving}
                onClick={() => setChoosing(true)}
              >
                Choose from library
              </Button>
              <Button
                type="button"
                variant="ghost"
                className="h-11 rounded-full px-3"
                disabled={saving}
                onClick={() => setWriting("new")}
              >
                Save to library
              </Button>
              <Button
                type="button"
                className="ml-auto h-11 rounded-full px-4"
                disabled={saving}
                onClick={() => void submit()}
              >
                Done
              </Button>
            </div>
          ) : (
            <Button
              type="button"
              className="h-11 shrink-0 self-end rounded-full px-5"
              disabled={saving}
              onClick={() => void submit()}
            >
              Done
            </Button>
          )}
        </div>
      </PopupContent>
      {library && (
        <>
          <PromptLibrarySheet
            open={choosing}
            onOpenChange={setChoosing}
            entries={entries}
            onPick={(entry) => void pick(entry)}
            onEdit={(entry) => {
              setChoosing(false)
              setWriting(entry)
            }}
          />
          <PromptEntrySheet
            // Keyed by what it writes: a new open starts from the row it names rather than from the
            // last thing typed into it.
            key={writing === null ? "closed" : writing === "new" ? "new" : writing.id}
            open={writing !== null}
            onOpenChange={(next) => !next && setWriting(null)}
            entry={writing === "new" ? null : writing}
            prompt={text}
            onSave={write}
            onDelete={remove}
          />
        </>
      )}
    </Popup>
  )
}

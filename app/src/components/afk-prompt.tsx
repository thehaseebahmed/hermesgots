/**
 * A project's Prompt, written: how its AFK work is carried out. Its own bottom sheet — the app's own
 * pop-up, so a drawer from a laptop's width — with the words in a field deep enough to read them in.
 * Done writes it and closes on the host's answer; the sheet's own way out leaves the words unwritten,
 * and a refused write is said by the caller, which is why the draft stays as typed.
 *
 * Where the account's library is offered — signed in, with the vault unlocked — two doors stand under
 * the field: Choose from library, which copies an entry's words in and writes them the way Done does
 * (a pick is a copy, so the host clears a picked workflow as it does for any Prompt), and Save to
 * library, which keeps the words on screen under a name and tags. Without the library this is the
 * editor it always was.
 */
import { useState } from "react"
import { toast } from "sonner"

import { Popup, PopupContent, PopupHeader, PopupTitle } from "@/components/popup"
import { PromptEntrySheet, PromptLibrarySheet } from "@/components/prompt-library-sheet"
import { Button } from "@/components/ui/button"
import { Textarea } from "@/components/ui/textarea"
import type { PromptDraft, PromptEntry } from "@/lib/prompt-library"
import { addPrompt, removePrompt, savePrompt, usePromptEntries } from "@/lib/prompt-library-store"

export function PromptEditor({
  open,
  onOpenChange,
  prompt,
  onSave,
  library = false,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  prompt: string
  /**
   * Writes the words, and — where they were copied from the account's library — the entry they came
   * from beside them. Done hands over the words alone, which detaches the copy on the host; a pick
   * hands over both, so the row can tell a copy whose entry moves on from an original.
   */
  onSave: (prompt: string, promptId?: string | null) => Promise<"saved" | "refused">
  /** The account's library is drawn here: signed in, with the vault open on this device. */
  library?: boolean
}) {
  const [text, setText] = useState(prompt)
  const [saving, setSaving] = useState(false)
  // Each open starts from the words the row holds rather than from the draft the last one left, and
  // the sheet stays the same instance so its way out still animates.
  const [wasOpen, setWasOpen] = useState(open)
  if (open !== wasOpen) {
    setWasOpen(open)
    if (open) setText(prompt)
  }

  const entries = usePromptEntries(library)
  const [choosing, setChoosing] = useState(false)
  // One entry sheet for both doors: a new entry saving the words on screen, or an entry being
  // renamed, rewritten or deleted.
  const [writing, setWriting] = useState<PromptEntry | "new" | null>(null)

  const submit = async () => {
    // Done on the words the row already holds is not a write: it would turn the host's default into
    // this project's own words, which nothing then reads as the default again.
    if (text === prompt) {
      onOpenChange(false)
      return
    }
    setSaving(true)
    try {
      if ((await onSave(text)) === "saved") onOpenChange(false)
    } finally {
      setSaving(false)
    }
  }

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
    setSaving(true)
    try {
      await onSave(entry.body, entry.id)
    } finally {
      setSaving(false)
    }
  }

  const write = async (draft: PromptDraft) => {
    const editing = writing === "new" ? null : writing
    try {
      if (editing) await savePrompt(editing.id, draft)
      else await addPrompt(draft)
      setWriting(null)
    } catch (failure) {
      toast.error(failure instanceof Error ? failure.message : "Couldn't save that Prompt.")
    }
  }

  const remove = async (entry: PromptEntry) => {
    try {
      await removePrompt(entry.id)
      setWriting(null)
    } catch (failure) {
      toast.error(failure instanceof Error ? failure.message : "Couldn't delete that Prompt.")
    }
  }

  return (
    <Popup open={open} onOpenChange={onOpenChange}>
      <PopupContent>
        <PopupHeader>
          <PopupTitle>Prompt</PopupTitle>
        </PopupHeader>
        <div className="flex min-h-0 flex-1 flex-col gap-3 px-4 pb-4 sm:px-6">
          <Textarea
            aria-label="Prompt"
            placeholder="How this project's work is carried out"
            className="min-h-[38dvh] resize-none rounded-2xl px-4 py-3 text-base md:text-[15px]"
            value={text}
            onChange={(event) => setText(event.target.value)}
          />
          {library && (
            <div className="flex flex-wrap gap-2" data-prompt-library-actions>
              <Button
                type="button"
                variant="secondary"
                className="h-10 rounded-full px-4"
                disabled={saving}
                onClick={() => setChoosing(true)}
              >
                Choose from library
              </Button>
              <Button
                type="button"
                variant="ghost"
                className="h-10 rounded-full px-4"
                disabled={saving}
                onClick={() => setWriting("new")}
              >
                Save to library
              </Button>
            </div>
          )}
          <Button
            className="h-11 shrink-0 self-end rounded-full px-5"
            disabled={saving}
            onClick={() => void submit()}
          >
            Done
          </Button>
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

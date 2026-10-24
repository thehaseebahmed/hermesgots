/**
 * The account's prompt library, drawn: the list a project picks from — name, tags and the body's
 * first line — and one entry's own sheet, which is both how an entry is saved and how it is renamed,
 * rewritten or deleted. Nothing here talks to a host: a pick hands the entry back to the editor,
 * which writes its words the way Done does.
 *
 * Deleting an entry removes it from the library only. A pick is a copy, so every Prompt that already
 * took the words keeps them.
 */
import { useState } from "react"

import { Popup, PopupContent, PopupHeader, PopupTitle } from "@/components/popup"
import { SheetPickerList, SheetPickerRow } from "@/components/sheet-picker"
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Textarea } from "@/components/ui/textarea"
import {
  bodyPreview,
  promptFilled,
  promptTags,
  tagsText,
  type PromptDraft,
  type PromptEntry,
} from "@/lib/prompt-library"

/**
 * The library to choose from. A row tapped picks it — the editor writes the words and closes this
 * sheet — and the pencil opens the entry to rename, rewrite or delete.
 */
export function PromptLibrarySheet({
  open,
  onOpenChange,
  entries,
  onPick,
  onEdit,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  /** The library as this device holds it; undefined until the first read lands. */
  entries: PromptEntry[] | undefined
  onPick: (entry: PromptEntry) => void
  onEdit: (entry: PromptEntry) => void
}) {
  return (
    <Popup open={open} onOpenChange={onOpenChange}>
      <PopupContent>
        <PopupHeader className="pb-2">
          <PopupTitle>Choose a Prompt</PopupTitle>
        </PopupHeader>
        <div className="flex min-h-0 flex-col gap-3 px-4 pb-4 sm:px-6" data-prompt-library>
          <SheetPickerList
            entries={entries}
            label="Prompts"
            reading="Reading prompts…"
            empty="No prompts yet. Save this project's words to the library to start it."
            row={(entry) => (
              <SheetPickerRow
                key={entry.id}
                attribute="data-prompt"
                id={entry.id}
                name={entry.name}
                pickLabel={`Use ${entry.name}`}
                onPick={() => onPick(entry)}
                onEdit={() => onEdit(entry)}
              >
                <span className="min-w-0 truncate text-base">{entry.name}</span>
                {entry.tags.length > 0 && (
                  <span className="flex min-w-0 flex-wrap items-center gap-1">
                    {entry.tags.map((tag) => (
                      <Badge key={tag} variant="secondary">
                        {tag}
                      </Badge>
                    ))}
                  </span>
                )}
                <span className="min-w-0 truncate text-sm text-muted-foreground">
                  {bodyPreview(entry.body)}
                </span>
              </SheetPickerRow>
            )}
          />
        </div>
      </PopupContent>
    </Popup>
  )
}

/**
 * One entry, written: its name, the tags it is found by, and its words. Opened on a blank draft it
 * saves the Prompt on screen as a new entry; opened on an entry it is that entry's rename and
 * rewrite, with Delete there for the library alone.
 */
export function PromptEntrySheet({
  open,
  onOpenChange,
  entry,
  prompt,
  onSave,
  onDelete,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  /** The entry being edited, or null to save the project's Prompt as a new one. */
  entry: PromptEntry | null
  /** The words the editor holds, which a new entry starts from. */
  prompt: string
  onSave: (draft: PromptDraft) => Promise<void>
  /** Removes one of the account's own entries. Never offered for a new one. */
  onDelete: (entry: PromptEntry) => Promise<void>
}) {
  const [name, setName] = useState(entry?.name ?? "")
  const [tags, setTags] = useState(tagsText(entry?.tags ?? []))
  const [body, setBody] = useState(entry?.body ?? prompt)
  const [saving, setSaving] = useState(false)

  const draft: PromptDraft = { name, tags: promptTags(tags), body }

  const submit = async () => {
    if (!promptFilled(draft)) return
    setSaving(true)
    try {
      await onSave(draft)
    } finally {
      setSaving(false)
    }
  }

  return (
    <Popup open={open} onOpenChange={onOpenChange}>
      <PopupContent>
        <PopupHeader className="pb-2">
          <PopupTitle>{entry ? "Edit Prompt" : "Save to library"}</PopupTitle>
        </PopupHeader>
        <div className="flex min-h-0 flex-1 flex-col gap-3 px-4 pb-4 sm:px-6" data-prompt-entry>
          <Input
            aria-label="Name"
            placeholder="What this Prompt is for"
            className="h-11 rounded-2xl px-4"
            value={name}
            onChange={(event) => setName(event.target.value)}
          />
          <Input
            aria-label="Tags"
            placeholder="Tags, separated by commas"
            className="h-11 rounded-2xl px-4"
            value={tags}
            onChange={(event) => setTags(event.target.value)}
          />
          <Textarea
            aria-label="Body"
            placeholder="How this project's work is carried out"
            className="min-h-[26dvh] resize-none rounded-2xl px-4 py-3 text-base md:text-[15px]"
            value={body}
            onChange={(event) => setBody(event.target.value)}
          />
          <div className="flex items-center justify-between gap-2">
            {entry && (
              <AlertDialog>
                <AlertDialogTrigger
                  render={<Button type="button" variant="ghost" disabled={saving} />}
                >
                  Delete
                </AlertDialogTrigger>
                <AlertDialogContent>
                  <AlertDialogHeader>
                    <AlertDialogTitle>Delete this Prompt?</AlertDialogTitle>
                    <AlertDialogDescription>
                      {entry.name} is removed from the library. Projects that already took its words
                      keep them.
                    </AlertDialogDescription>
                  </AlertDialogHeader>
                  <AlertDialogFooter>
                    <AlertDialogCancel render={<Button type="button" variant="ghost" />}>
                      Cancel
                    </AlertDialogCancel>
                    <AlertDialogAction
                      render={<Button type="button" variant="destructive" />}
                      onClick={() => void onDelete(entry)}
                    >
                      Delete
                    </AlertDialogAction>
                  </AlertDialogFooter>
                </AlertDialogContent>
              </AlertDialog>
            )}
            <Button
              type="button"
              className="ml-auto h-11 rounded-full px-5"
              disabled={saving || !promptFilled(draft)}
              onClick={() => void submit()}
            >
              Save
            </Button>
          </div>
        </div>
      </PopupContent>
    </Popup>
  )
}

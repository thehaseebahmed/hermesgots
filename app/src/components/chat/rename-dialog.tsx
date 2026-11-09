import { useEffect, useState } from "react"

import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog"
import { Input } from "@/components/ui/input"
import { Spinner } from "@/components/ui/spinner"

/**
 * One field asked for, and saved: the shape a chat's rename and a room's rename both need.
 *
 * The field opens with `value` and the dialog asks again each time it opens, so a caller never has to
 * seed a name itself. A save that rejects keeps the dialog open and says the reason where the name
 * was asked — which is what a room's rename needs, since the Host's refusal is the answer and the
 * room still wears its old name (ADR 0122): the caller rejects, and the words are shown as given.
 */
export function RenameDialog({
  open,
  onOpenChange,
  title,
  fieldLabel,
  value,
  saveLabel = "Save",
  onSave,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  /** What the dialog is called: "Rename chat", "Edit session", "Rename room". */
  title: string
  /** What the field is called for a screen reader: "Chat title", "Room name". */
  fieldLabel: string
  /** The name the field opens with. */
  value: string
  saveLabel?: string
  /** Saves it. A rejection leaves the dialog open with its message shown. */
  onSave: (name: string) => Promise<void> | void
}) {
  const [name, setName] = useState(value)
  const [saving, setSaving] = useState(false)
  const [failure, setFailure] = useState<string>()

  // Every opening starts from the name the caller holds, and from nothing said about the last one. A
  // name that changes while the dialog is open is not an opening: a merge landing another device's
  // title must not wipe what the user is typing.
  useEffect(() => {
    if (!open) return
    setName(value)
    setFailure(undefined)
    // Only an opening seeds it: a name that changes while the dialog is open is another device's news,
    // and it must not wipe what the user is typing.
  }, [open])

  const save = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    const trimmed = name.trim()
    if (!trimmed || saving) return
    setSaving(true)
    setFailure(undefined)
    try {
      await onSave(trimmed)
      onOpenChange(false)
    } catch (error) {
      setFailure(error instanceof Error && error.message ? error.message : "That didn't save.")
    } finally {
      setSaving(false)
    }
  }

  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      <AlertDialogContent>
        <form className="contents" onSubmit={save}>
          <AlertDialogHeader>
            <AlertDialogTitle>{title}</AlertDialogTitle>
          </AlertDialogHeader>
          <Input
            value={name}
            onChange={(event) => setName(event.target.value)}
            autoFocus
            aria-label={fieldLabel}
          />
          {failure && (
            <p role="alert" className="text-sm text-destructive">
              {failure}
            </p>
          )}
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction type="submit" disabled={saving || !name.trim()}>
              {saving ? <Spinner /> : saveLabel}
            </AlertDialogAction>
          </AlertDialogFooter>
        </form>
      </AlertDialogContent>
    </AlertDialog>
  )
}

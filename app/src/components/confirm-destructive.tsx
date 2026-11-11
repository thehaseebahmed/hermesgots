/**
 * The one destructive confirmation: a title, what it does, a Cancel that writes nothing, and the one
 * button that does it.
 *
 * The dialog is the action's own. It holds its button while the write runs, closes once the write
 * lands, and — where the write returns a promise — keeps itself open with the host's own words when
 * it is refused. That last part is why the app has one of these: a refusal shown in a toast is gone
 * before a reader looking at a dialog thinks to look for it.
 *
 * `busy` is for a caller whose write already has a state of its own elsewhere on the screen, so the
 * dialog can be held open without the caller wrapping its handler in a promise it does not need.
 */
import { useState } from "react"

import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog"
import { Spinner } from "@/components/ui/spinner"

export function ConfirmDestructive({
  open,
  title,
  description,
  confirmLabel,
  cancelLabel = "Cancel",
  busy,
  staysOpen,
  onOpenChange,
  onConfirm,
}: {
  open: boolean
  title: string
  description: React.ReactNode
  confirmLabel: string
  /** The way out of the question, where Cancel isn't the word the dialog wants. */
  cancelLabel?: string
  /** A write the caller is already tracking: the dialog waits with it. */
  busy?: boolean
  /** The caller closes the question itself, once its write has an answer worth reading. */
  staysOpen?: boolean
  onOpenChange: (open: boolean) => void
  /** Does it. A rejection keeps the dialog open and prints its message. */
  onConfirm: () => unknown
}) {
  const [running, setRunning] = useState(false)
  const [failure, setFailure] = useState<string>()
  const held = running || Boolean(busy)
  const run = async () => {
    if (held) return
    setRunning(true)
    setFailure(undefined)
    try {
      await onConfirm()
      // A caller whose write can answer without saying it landed (`staysOpen`) closes the question
      // itself, so an unreadable answer can keep it up.
      if (!staysOpen) onOpenChange(false)
    } catch (error) {
      setFailure(error instanceof Error && error.message ? error.message : "That didn't work.")
    } finally {
      setRunning(false)
    }
  }
  return (
    <AlertDialog
      open={open}
      onOpenChange={(next) => {
        if (!next && held) return
        setFailure(undefined)
        onOpenChange(next)
      }}
    >
      <AlertDialogContent size="sm">
        <AlertDialogHeader>
          <AlertDialogTitle>{title}</AlertDialogTitle>
          <AlertDialogDescription>{description}</AlertDialogDescription>
        </AlertDialogHeader>
        {failure && (
          <p role="alert" className="text-sm text-destructive">
            {failure}
          </p>
        )}
        <AlertDialogFooter>
          <AlertDialogCancel disabled={held}>{cancelLabel}</AlertDialogCancel>
          <AlertDialogAction
            variant="destructive"
            disabled={held}
            // The action is a close button in the primitive; the write decides when it closes.
            onClick={(event) => {
              event.preventDefault()
              void run()
            }}
          >
            {running ? <Spinner /> : confirmLabel}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}

import { useState, type ReactNode } from "react"

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

/**
 * The question an action that cannot be taken back asks first: a title, what it will do, and the one
 * button that does it.
 *
 * The dialog is the action's own: it holds the button while the promise runs, closes once it settles,
 * and keeps itself open with the reason when it rejects — which is what a room's disband needs, since
 * the Host's refusal is its answer and the words are the Host's (ADR 0122). A caller says what happens
 * and nothing about when.
 */
export function ConfirmDialog({
  open,
  onOpenChange,
  title,
  description,
  confirm,
  onConfirm,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  title: string
  description: ReactNode
  /** The action's own word: "Delete", "Discard", "Disband". */
  confirm: string
  /** Does it. A rejection leaves the dialog open with its message shown. */
  onConfirm: () => Promise<void> | void
}) {
  const [running, setRunning] = useState(false)
  const [failure, setFailure] = useState<string>()

  const run = async () => {
    if (running) return
    setRunning(true)
    setFailure(undefined)
    try {
      await onConfirm()
      onOpenChange(false)
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
          <AlertDialogCancel>Cancel</AlertDialogCancel>
          <AlertDialogAction variant="destructive" disabled={running} onClick={() => void run()}>
            {running ? <Spinner /> : confirm}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}

import { useCallback, useEffect, useRef, useState, type ReactNode } from "react"

import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog"
import { db, deleteConversation, updateConversation, type Conversation } from "@/lib/db"
import { draftKey, loadDraft } from "@/lib/drafts"
import { setBackGuard } from "@/lib/native"
import { useNav } from "@/lib/nav"

const CODE = "/code"

/**
 * Leaving a project session, whichever screen draws it. A session sits under Code, unless it is
 * drawn beside Code's list, and one nothing was sent in isn't kept: deleted, or kept as a draft when
 * something was typed, which is the user's to decide when there is a chance to ask (the back button
 * and Android's back) and kept when there is not (another session picked beside the list).
 *
 * `unsent` says whether nothing was sent in a session, which each screen knows its own way.
 * Returns the way back, whether the session leads back at all, and the dialog that asks.
 */
export function useSessionLeave({
  id,
  session,
  beside,
  unsent,
}: {
  /** The chat on screen, which changes under a pane when another session is picked. */
  id: string | undefined
  session: Conversation | undefined
  /** The session is drawn beside Code's list, so it has nothing to go back to. */
  beside: boolean
  unsent: (chat: Conversation) => Promise<boolean>
}): { leave: () => Promise<void>; underCode: boolean; dialog: ReactNode } {
  const { up } = useNav()
  const [asking, setAsking] = useState(false)
  const leave = useCallback(async () => {
    if (!session) return
    if (!(await unsent(session))) return up(CODE)
    if ((await loadDraft(draftKey(session.id))).trim()) return setAsking(true)
    void deleteConversation(session.id)
    up(CODE)
  }, [session, unsent, up])
  const leaveRef = useRef(leave)
  useEffect(() => {
    leaveRef.current = leave
  })
  const underCode = Boolean(session) && !beside
  useEffect(() => {
    if (!underCode) return
    return setBackGuard(() => {
      void leaveRef.current()
      return true
    })
  }, [underCode])
  const unsentRef = useRef(unsent)
  useEffect(() => {
    unsentRef.current = unsent
  })
  // Beside Code's list another session can be picked straight away, with no chance to ask.
  const shown = useRef(id)
  useEffect(() => {
    const left = shown.current
    shown.current = id
    if (!left || left === id) return
    void (async () => {
      const row = await db.conversations.get(left)
      if (!row?.projectId || row.draftAt || !(await unsentRef.current(row))) return
      if ((await loadDraft(draftKey(left))).trim())
        await updateConversation(left, { draftAt: Date.now() })
      else await deleteConversation(left)
    })()
  }, [id])
  const dialog = (
    <AlertDialog open={asking} onOpenChange={setAsking}>
      <AlertDialogContent size="sm">
        <AlertDialogHeader>
          <AlertDialogTitle>Save your draft?</AlertDialogTitle>
          <AlertDialogDescription>
            This session hasn't started. Save the draft to pick it up later, or delete the session.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogAction
            variant="outline"
            onClick={async () => {
              if (!session) return
              await deleteConversation(session.id)
              up(CODE)
            }}
          >
            Delete
          </AlertDialogAction>
          <AlertDialogAction
            onClick={async () => {
              if (!session) return
              await updateConversation(session.id, { draftAt: Date.now() })
              up(CODE)
            }}
          >
            Save draft
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
  return { leave, underCode, dialog }
}

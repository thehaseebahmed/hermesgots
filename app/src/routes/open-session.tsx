import { useEffect } from "react"
import { Navigate, useNavigate, useParams } from "react-router"
import { toast } from "sonner"

import { Spinner } from "@/components/ui/spinner"
import { db } from "@/lib/db"
import { onOpenPush } from "@/lib/push"
import { syncNow } from "@/lib/sync"

const FIND_TRIES = 5
const SYNC_WAIT_MS = 5000
const RETRY_MS = 1000

const wait = (ms: number) => new Promise((done) => setTimeout(done, ms))

/**
 * Where a push notification lands: the chat of the Hermes session that needs the user. A chat
 * started on another device may not have reached this one yet, so it syncs until it has.
 */
export function OpenSessionPage() {
  const { sessionId } = useParams()
  const navigate = useNavigate()
  useEffect(() => {
    let cancelled = false
    const find = () =>
      db.conversations
        .where("hermesSessionId")
        .equals(sessionId ?? "")
        .first()
    void (async () => {
      let chat = await find()
      for (let tries = 0; !chat && !cancelled && tries < FIND_TRIES; tries++) {
        await Promise.race([syncNow().catch(() => undefined), wait(SYNC_WAIT_MS)])
        chat = await find()
        if (!chat) await wait(RETRY_MS)
      }
      if (cancelled) return
      if (!chat) toast.error("Couldn't find that chat on this device.")
      navigate(chat ? `/c/${chat.id}` : "/", { replace: true })
    })()
    return () => {
      cancelled = true
    }
  }, [sessionId, navigate])
  if (!sessionId) return <Navigate to="/" replace />
  return (
    <div className="flex flex-1 items-center justify-center">
      <Spinner className="size-6" />
    </div>
  )
}

/** Opens what a tapped Android notification is about. Renders nothing. */
export function PushLinks() {
  const navigate = useNavigate()
  useEffect(() => onOpenPush((path) => navigate(path)), [navigate])
  return null
}

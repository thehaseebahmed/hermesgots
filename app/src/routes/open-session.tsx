import { useEffect } from "react"
import { Navigate, useNavigate, useParams } from "react-router"

import { db } from "@/lib/db"
import { onOpenSession } from "@/lib/push"

/** Where a push notification lands: the chat of the Hermes session that needs the user. */
export function OpenSessionPage() {
  const { sessionId } = useParams()
  const navigate = useNavigate()
  useEffect(() => {
    let cancelled = false
    void db.conversations
      .filter((chat) => chat.hermesSessionId === sessionId)
      .first()
      .then((chat) => {
        if (!cancelled) navigate(chat ? `/c/${chat.id}` : "/", { replace: true })
      })
    return () => {
      cancelled = true
    }
  }, [sessionId, navigate])
  return sessionId ? null : <Navigate to="/" replace />
}

/** Opens the session of a tapped Android notification. Renders nothing. */
export function PushLinks() {
  const navigate = useNavigate()
  useEffect(
    () => onOpenSession((sessionId) => navigate(`/s/${encodeURIComponent(sessionId)}`)),
    [navigate],
  )
  return null
}

import { useEffect } from "react"
import { useLiveQuery } from "dexie-react-hooks"
import { Navigate, useNavigate, useParams } from "react-router"
import { toast } from "sonner"

import { Spinner } from "@/components/ui/spinner"
import { chatIdForSession, listReachableProfiles } from "@/lib/db"
import { onOpenPush } from "@/lib/push"
import { quietly } from "@/lib/report"
import { syncChatsOf } from "@/lib/sync"

/** Passes at the chat lists before the screen gives up on the chat arriving. */
const PASSES = 2

/**
 * Where a push notification lands: the chat of the Hermes session that needs the user. A chat this
 * device already holds opens on its own row, with no read of the network at all; one started on
 * another device is looked for in the chat lists of the bots that could hold it — those alone, not
 * the account documents or a whole sync — in at most two passes.
 *
 * The row is followed rather than polled for: a live query answers on the write that merges it, so
 * the chat opens at its row rather than at the end of the pass looking for it.
 */
export function OpenSessionPage() {
  const { sessionId } = useParams()
  const session = sessionId ?? ""
  const navigate = useNavigate()
  const answer = useLiveQuery(
    async () => ({ session, chat: (await chatIdForSession(session)) ?? null }),
    [session],
  )
  // `undefined` until the query answers for this session; `null` once it says this device has none.
  const chat = answer?.session === session ? answer.chat : undefined

  useEffect(() => {
    if (chat) navigate(`/c/${chat}`, { replace: true })
  }, [chat, navigate])

  useEffect(() => {
    // Nothing to look for until the device has answered that it holds no such chat.
    if (!session || chat !== null) return
    let cancelled = false
    void (async () => {
      // A session is minted by the bot that ran it, so only a bot's own chat list can hold the chat:
      // a turned-off bot's can't, and the account documents speak of no session at all.
      const bots = (await listReachableProfiles()).map((bot) => bot.id)
      for (let pass = 0; pass < PASSES && !cancelled; pass++) {
        // Each pass is bounded where it runs (`CHATS_MERGE_WAIT_MS` inside the chat lane), so the
        // next is asked for only once this one is out: asking while one runs queues another merge.
        await syncChatsOf(bots).catch(quietly("Reading the chat lists"))
        if (cancelled) return
        if ((await chatIdForSession(session)) === undefined) continue
        return
      }
      if (cancelled) return
      toast.error("Couldn't find that chat on this device.")
      navigate("/", { replace: true })
    })()
    return () => {
      cancelled = true
    }
  }, [session, chat, navigate])

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

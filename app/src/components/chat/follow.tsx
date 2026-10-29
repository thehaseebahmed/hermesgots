import { useEffect, useRef } from "react"

import { useMessageScroller } from "@/components/ui/message-scroller"

/** An approval or question card temporarily replaces the composer; once answered, follow the reply again. */
export function FollowAfterApproval({ pending }: { pending: boolean }) {
  const { scrollToEnd } = useMessageScroller()
  const wasPending = useRef(pending)
  useEffect(() => {
    if (wasPending.current && !pending) scrollToEnd({ behavior: "smooth" })
    wasPending.current = pending
  }, [pending, scrollToEnd])
  return null
}

/** Sending jumps back to the end, even if you'd scrolled up to read. */
export function FollowOnSend({ lastUserId }: { lastUserId?: string }) {
  const { scrollToEnd } = useMessageScroller()
  const previous = useRef(lastUserId)
  useEffect(() => {
    if (lastUserId !== previous.current) scrollToEnd({ behavior: "smooth" })
    previous.current = lastUserId
  }, [lastUserId, scrollToEnd])
  return null
}

import { useEffect, useState } from "react"

import { BUSY_WORD_MS, busyWord, type BusyKind } from "@/lib/busy-words"

/** The status word for a kind of work, moved on every `BUSY_WORD_MS` while `kind` is asked for. */
export function useBusyWord(kind: BusyKind | undefined, seed: string) {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (!kind) return
    const timer = setInterval(() => setNow(Date.now()), BUSY_WORD_MS)
    return () => clearInterval(timer)
  }, [kind])
  return kind ? busyWord(kind, seed, now) : undefined
}

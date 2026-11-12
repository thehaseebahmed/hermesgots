/**
 * The one refusal a surface holds, and the writes it answers.
 *
 * `write` runs one of the surface's writes: the words it is already holding go as the write starts,
 * so a second refusal replaces the first rather than standing beside it, and whatever `attempt`
 * answered is handed to `refuse` (lib/refusal.ts) — drawn where the control is, or said in passing
 * where the host left the app its own sentence. The hold is keyed by its subject, the way a read's is
 * (`readAttempt`): a surface about something else — the next bot, the next meeting — carries none of
 * what was said about the one before it, since the refusal is about the attempt that caused it.
 */
import { useCallback, useEffect, useRef, useState } from "react"

import { attempt } from "@/lib/attempt"
import { refuse, type Attempted, type RefusalHold } from "@/lib/refusal"
import { tell } from "@/lib/tell"

/**
 * `subject` names what the refusal is about — a bot, a chat, a canvas. It changes, and the words go:
 * unmounting is not leaving, since one screen can turn from one subject to the next.
 */
export function useRefusal(subject?: string): RefusalHold {
  const [words, setWords] = useState<string>()

  /** The reader's control, or the surface moving on: the words go until the next refusal. */
  const clear = useCallback(() => setWords(undefined), [])

  /** What `attempt` answered, drawn or said: the one place the decision reaches the screen. */
  const take = useCallback((result: Attempted) => {
    const decided = refuse(result)
    // `alone` is the app's own sentence by `refuse`'s decision — the one toast this change keeps,
    // said where the host left nothing of its own to hold.
    if (decided.alone) tell.error(decided.alone)
    setWords(decided.hold)
  }, [])

  const write = useCallback(
    async (what: string, action: () => Promise<unknown>) => {
      setWords(undefined)
      const answer = await attempt(what, action)
      take(answer)
      return answer.ok
    },
    [take],
  )

  // Registered before the caller's own effects, so a surface that turns to another subject draws
  // nothing of the one it left even when that subject's read lands in the same commit.
  const lastSubject = useRef(subject)
  useEffect(() => {
    if (lastSubject.current === subject) return
    lastSubject.current = subject
    setWords(undefined)
  }, [subject])

  return { words, refuse: take, write, clear, dismiss: clear }
}

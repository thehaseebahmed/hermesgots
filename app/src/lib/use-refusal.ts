/**
 * The one refusal a surface holds, and the writes it answers.
 *
 * `write` runs one of the surface's writes: the words it is already holding go as the write starts,
 * so a second refusal replaces the first rather than standing beside it, and whatever `attempt`
 * answered is handed to `refuse` (lib/refusal.ts) — drawn where the control is, or said in passing
 * where the host left the app its own sentence. The hold is keyed by its subject, the way a read's is
 * (`readAttempt`): a surface about something else — the next bot, the next meeting — carries none of
 * what was said about the one before it, since the refusal is about the attempt that caused it.
 *
 * `useSaidRefusal` is the same hold for a surface with nothing standing to draw one: the words are
 * said in passing instead, so a failure is never kept where no reader would see it.
 */
import { useCallback, useEffect, useRef, useState } from "react"

import { attempt } from "@/lib/attempt"
import { refuse, type Attempted, type RefusalHold } from "@/lib/refusal"
import { tell } from "@/lib/tell"

/** Says one refused write in passing, for a surface that has nothing to draw it. */
const say = (words: string) => tell.error(words)

/**
 * `subject` names what the refusal is about — a bot, a chat, a canvas. It changes, and the words go:
 * unmounting is not leaving, since one screen can turn from one subject to the next.
 *
 * `land` is where the host's words go: nowhere (`undefined`) for a hold a `Refusal` draws, and `say`
 * for a surface with no notice in the tree, whose words a reader would otherwise never see.
 */
function useKeptRefusal(land: ((words: string) => void) | undefined, subject?: string): RefusalHold {
  const [words, setWords] = useState<string>()

  /** The reader's control, or the surface moving on: the words go until the next refusal. */
  const clear = useCallback(() => setWords(undefined), [])

  /** What `attempt` answered, drawn or said: the one place the decision reaches the screen. */
  const take = useCallback(
    (result: Attempted) => {
      const decided = refuse(result)
      // `alone` is the app's own sentence by `refuse`'s decision — the one toast this change keeps,
      // said where the host left nothing of its own to hold.
      if (decided.alone) tell.error(decided.alone)
      if (!land) return setWords(decided.hold)
      // Nothing draws a hold here, so the host's own words are said rather than kept.
      if (decided.hold) land(decided.hold)
    },
    [land],
  )

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

/** The refusal a surface holds, drawn in a `Refusal` where the surface stands. */
export function useRefusal(subject?: string): RefusalHold {
  return useKeptRefusal(undefined, subject)
}

/**
 * The refusal a surface with no notice in the tree keeps (the plan's G2): a message row drawn
 * outside the chat's providers, a page mounted without its `Screen`. There is nowhere for the host's
 * words to stand, so they are said in passing — the same passing sentence the app uses for a host
 * that said nothing, and never both at once.
 */
export function useSaidRefusal(subject?: string): RefusalHold {
  return useKeptRefusal(say, subject)
}

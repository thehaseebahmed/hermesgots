import type { MessageStats } from "./db.ts"

/** A reply's length in tokens where Hermes sent no count: a stopped turn never gets one. */
export const estimateTokens = (text: string) => Math.max(1, Math.round(text.length / 4))

/** When a turn this device sent began, and when its first word came, in this device's own ms. */
export interface Timing {
  startedAt: number
  firstTokenAt?: number
}

/**
 * What a reply cost, as the thread says it under the reply: its tokens (Hermes's count, else an
 * estimate from its words), how long it took, and how fast it wrote — left out when calls ran, since
 * the turn's time then includes their execution, when nothing streamed, or when the turn was picked
 * up in its middle (`resumed`): only a turn this device saw from its start has an honest speed.
 */
export function measureReply(input: {
  text: string
  toolsUsed: boolean
  /** Hermes's count of the reply's tokens, where the run's end carried it. */
  counted?: number
  /** Hermes's prompt tokens, summed over every model call in the turn. */
  promptTokens?: number
  resumed?: boolean
  startedAt: number
  /** When the first word came; none when nothing streamed (the run's final output alone arrived). */
  firstTokenAt?: number | null
  endedAt: number
}): MessageStats {
  const { text, toolsUsed, counted, promptTokens, resumed, startedAt, firstTokenAt, endedAt } =
    input
  const tokens = counted || estimateTokens(text)
  const writingMs = Math.max(1, endedAt - (firstTokenAt ?? endedAt))
  return {
    tokens,
    estimated: !counted,
    tokensPerSecond:
      toolsUsed || resumed || firstTokenAt == null
        ? undefined
        : Math.round(tokens / (writingMs / 1000)),
    durationMs: endedAt - startedAt,
    promptTokens: promptTokens || undefined,
    toolsUsed,
  }
}

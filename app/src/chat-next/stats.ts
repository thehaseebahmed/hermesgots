import type { MessageStats } from "../lib/db.ts"

/** Hermes's own count of the tokens a reply wrote, where the run's end carried it. */
export interface Usage {
  input_tokens?: number
  output_tokens?: number
}

/** When a turn this device sent began, and when its first word came, in this device's own ms. */
export interface Timing {
  startedAt: number
  firstTokenAt?: number
}

/** A reply's length in tokens where Hermes sent no count: a stopped turn never gets one. */
const estimate = (text: string) => Math.max(1, Math.round(text.length / 4))

/**
 * What a reply cost, as the thread says it under the reply: its tokens (Hermes's count, else an
 * estimate from its words), how long it took, and how fast it wrote — left out when calls ran, since
 * the turn's time then includes their execution, or when nothing streamed. Only a turn this device
 * saw from its start can be measured (`timing`); one followed from its middle has no honest figure.
 */
export function measureTurn(input: {
  text: string
  toolsUsed: boolean
  usage?: Usage
  timing: Timing
  endedAt: number
}): MessageStats {
  const { text, toolsUsed, usage, timing, endedAt } = input
  const counted = usage?.output_tokens || 0
  const tokens = counted || estimate(text)
  const streamed = timing.firstTokenAt !== undefined
  const writingMs = Math.max(1, endedAt - (timing.firstTokenAt ?? endedAt))
  return {
    tokens,
    estimated: !counted,
    ...(toolsUsed || !streamed ? {} : { tokensPerSecond: Math.round(tokens / (writingMs / 1000)) }),
    durationMs: endedAt - timing.startedAt,
    ...(usage?.input_tokens ? { promptTokens: usage.input_tokens } : {}),
    toolsUsed,
  }
}

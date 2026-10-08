/** USD per million tokens. Cache writes are priced as Hermes's default 5-minute writes. */
interface Price {
  input: number
  output: number
  cacheWrite: number
  cacheRead: number
}

const price = (input: number, output: number, cacheRead: number): Price => ({
  input,
  output,
  cacheWrite: input * 1.25,
  cacheRead,
})

// Anthropic's first-party API prices (platform.claude.com/docs/en/about-claude/pricing, checked
// 2026-10-08). Bedrock and Vertex bill on their own price lists, so those sessions are estimates.
const CLAUDE: [string, Price][] = [
  ["claude-fable-5-1", price(10, 50, 0.25)],
  ["claude-mythos-5-1", price(10, 50, 0.25)],
  ["claude-fable-5", price(10, 50, 1)],
  ["claude-mythos-5", price(10, 50, 1)],
  ["claude-opus-5-5-fast", price(8, 40, 0.4)],
  ["claude-opus-5-5", price(4, 20, 0.2)],
  ["claude-opus-5-fast", price(10, 50, 1)],
  ["claude-opus-5", price(5, 25, 0.5)],
  ["claude-opus-4-8-fast", price(10, 50, 1)],
  ["claude-opus-4-8", price(5, 25, 0.5)],
  ["claude-opus-4-7", price(5, 25, 0.5)],
  ["claude-opus-4-6", price(5, 25, 0.5)],
  ["claude-opus-4-5", price(5, 25, 0.5)],
  ["claude-opus-4-1", price(15, 75, 1.5)],
  ["claude-opus-4", price(15, 75, 1.5)],
  ["claude-sonnet-5-5", price(2, 10, 0.1)],
  ["claude-sonnet-5", price(2, 10, 0.2)],
  ["claude-sonnet-4-6", price(3, 15, 0.3)],
  ["claude-sonnet-4-5", price(3, 15, 0.3)],
  ["claude-sonnet-4", price(3, 15, 0.3)],
  // Haiku 5.5 costs five times as much on prompts over 100k tokens; the session store only keeps
  // totals, so every call is priced as a short one.
  ["claude-haiku-5-5", price(0.1, 0.5, 0.01)],
  ["claude-haiku-4-5", price(1, 5, 0.1)],
  ["claude-3-5-haiku", price(0.8, 4, 0.08)],
]

/** "anthropic/claude-opus-4.8", "us.anthropic.claude-opus-4-8-v1:0" → "claude-opus-4-8-v1". */
function normalize(model: string) {
  return model
    .toLowerCase()
    .replace(/\[[^\]]*\]$/, "")
    .replace(/:.*$/, "")
    .split("/")
    .pop()!
    .replace(/^.*?anthropic\./, "")
    .replace(/\./g, "-")
    .trim()
}

/** The first-party Claude price for a model id from Hermes, or undefined for any other model. */
export function claudePrice(model: string | undefined): Price | undefined {
  if (!model) return undefined
  const id = normalize(model)
  // A date or version suffix ("-20250514", "-v1") still matches, a minor version doesn't:
  // claude-opus-5 isn't claude-opus-5-5. Each "-fast" id comes before its plain one.
  for (const [name, found] of CLAUDE) {
    if (id === name) return found
    if (id.startsWith(`${name}-`) && !/^\d(-|$)/.test(id.slice(name.length + 1))) return found
  }
  return undefined
}

export interface ModelUsage {
  model?: string
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheWriteTokens: number
  /** Hermes's own figure, used for models that aren't Claude. */
  costUsd?: number
}

/**
 * What the usage would cost: Claude models at Anthropic's prices, anything else at Hermes's own
 * figure when it has one. `partial` when some usage couldn't be priced.
 */
export function estimateCost(usage: ModelUsage[]): { usd: number; partial: boolean } {
  let usd = 0
  let partial = false
  for (const entry of usage) {
    const found = claudePrice(entry.model)
    if (found)
      usd +=
        (entry.inputTokens * found.input +
          entry.outputTokens * found.output +
          entry.cacheWriteTokens * found.cacheWrite +
          entry.cacheReadTokens * found.cacheRead) /
        1_000_000
    else if (entry.costUsd !== undefined) usd += entry.costUsd
    else if (
      entry.inputTokens +
      entry.outputTokens +
      entry.cacheReadTokens +
      entry.cacheWriteTokens
    )
      partial = true
  }
  return { usd, partial }
}

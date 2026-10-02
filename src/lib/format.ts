export function formatDuration(ms: number) {
  if (ms < 60_000) return `${Math.max(0.1, ms / 1000).toFixed(1)}s`
  const minutes = Math.floor(ms / 60_000)
  return `${minutes}m ${Math.round((ms % 60_000) / 1000)}s`
}

/** Compact token counts: 950, 12.3k, 339k, 1M. */
export function formatTokens(tokens: number) {
  const compact = (value: number, unit: string) =>
    `${value < 10 ? value.toFixed(1).replace(/\.0$/, "") : Math.round(value)}${unit}`
  if (tokens >= 1_000_000) return compact(tokens / 1_000_000, "M")
  if (tokens >= 1_000) return compact(tokens / 1_000, "k")
  return String(tokens)
}

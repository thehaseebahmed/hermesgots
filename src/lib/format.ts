export function formatDuration(ms: number) {
  if (ms < 60_000) return `${Math.max(0.1, ms / 1000).toFixed(1)}s`
  const minutes = Math.floor(ms / 60_000)
  return `${minutes}m ${Math.round((ms % 60_000) / 1000)}s`
}

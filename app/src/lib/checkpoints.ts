import { formatRelative } from "@/lib/format"
import { HermesError } from "@/lib/hermes"

const DAY_MS = 86_400_000

export function folderName(path: string) {
  return path.split(/[\\/]/).filter(Boolean).at(-1) ?? path
}

export function formatCheckpointTime(at: number, now: number) {
  if (now - at < DAY_MS) return formatRelative(at, now)
  return new Date(at).toLocaleString([], {
    day: "numeric",
    month: "short",
    hour: "numeric",
    minute: "2-digit",
  })
}

export function describeCheckpointError(error: unknown) {
  // The project list loaded, so a failure with no status is most likely an older plugin's 404, which
  // Hermes sends without CORS headers.
  if (error instanceof HermesError && !error.status)
    return "Couldn't load checkpoints. They need version 0.5 or later of the Memento plugin."
  return error instanceof Error ? error.message : "Couldn't load checkpoints."
}

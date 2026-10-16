import { useEffect, useState } from "react"

const SEEN = "memento:last-greeted"
const ABSENCE_MS = 60 * 60 * 1000

const LINES = [
  "Ready to get started. A little too excited, honestly.",
  "Running on electricity and optimism. Let's go.",
  "I've been waiting here very calmly. Mostly calmly.",
  "Nervous? Me? Okay, a little. Mostly ready.",
  "All warmed up and nothing to break yet.",
  "Tools sharpened. Tell me where to begin.",
]

/** The time of day's greeting, in the user's own clock. */
export const greetingAt = (now: Date) => {
  const hour = now.getHours()
  return hour < 12 ? "Good morning" : hour < 18 ? "Good afternoon" : "Good evening"
}

/** When this device last showed a greeting, if it can say. */
const lastGreeted = () => {
  try {
    return Number(localStorage.getItem(SEEN)) || 0
  } catch {
    return 0
  }
}

/** What each session was told, so a screen drawn again keeps its line. */
const told = new Map<string, { now?: number; text: string }>()

/**
 * What an unstarted session says: a short line about the bot being ready, with a greeting only when
 * the last one was an hour or more ago, so a user starting several sessions in a row hears it once.
 */
export function useReadyLine(sessionId: string) {
  const [line] = useState(() => {
    const known = told.get(sessionId)
    if (known) return known
    const now = Date.now()
    const text = LINES[Math.floor(Math.random() * LINES.length)]
    const made =
      now - lastGreeted() >= ABSENCE_MS
        ? { now, text: `${greetingAt(new Date(now))}. ${text}` }
        : { text }
    told.set(sessionId, made)
    return made
  })
  // Stamped once it shows, not while the line is chosen, which a double render would count twice.
  useEffect(() => {
    if (!line.now) return
    try {
      localStorage.setItem(SEEN, String(line.now))
    } catch {
      // Storage can be blocked; the greeting then shows each time.
    }
  }, [line.now])
  return line.text
}

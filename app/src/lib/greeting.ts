import { useEffect, useState } from "react"

import { BOTS, DEFAULT_BOT_ID } from "@/components/bots"

const SEEN = "memento:last-greeted"
const TURN = "memento:line-turn:"
const ABSENCE_MS = 60 * 60 * 1000

/** The time of day's greeting, in the user's own clock. */
export const greetingAt = (now: Date) => {
  const hour = now.getHours()
  return hour < 12 ? "Good morning." : hour < 18 ? "Good afternoon." : "Good evening."
}

const read = (key: string) => {
  try {
    return Number(localStorage.getItem(key)) || 0
  } catch {
    return 0
  }
}

const write = (key: string, value: number) => {
  try {
    localStorage.setItem(key, String(value))
  } catch {
    // Storage can be blocked; the greeting then shows each time and the lines start over.
  }
}

interface Told {
  greeting?: string
  line: string
  /** When the greeting was chosen, and which of the bot's lines the line was. */
  at?: number
  turn: number
}

/** What each session was told, so a screen drawn again keeps its line. */
const told = new Map<string, Told>()

function choose(botId: string): Told {
  const lines = (BOTS.find((b) => b.id === botId) ?? BOTS.find((b) => b.id === DEFAULT_BOT_ID)!)
    .lines
  const now = Date.now()
  const turn = read(TURN + botId) % lines.length
  const greet = now - read(SEEN) >= ABSENCE_MS
  return {
    greeting: greet ? greetingAt(new Date(now)) : undefined,
    line: lines[turn],
    at: greet ? now : undefined,
    turn,
  }
}

/**
 * What a chat or session not started yet says under its bot: a greeting only when the last one was
 * an hour or more ago, so starting several in a row greets once, and then one of the bot's five
 * lines, in turn, so the next one that opens has the next line.
 */
export function useReadyLine(botId: string, id?: string) {
  const [line] = useState(() => {
    const known = id ? told.get(id) : undefined
    if (known) return known
    const made = choose(botId)
    if (id) told.set(id, made)
    return made
  })
  // Marked once it shows, not while the line is chosen, which a double render would count twice.
  useEffect(() => {
    if (line.at) write(SEEN, line.at)
    write(TURN + botId, line.turn + 1)
  }, [line, botId])
  return line
}

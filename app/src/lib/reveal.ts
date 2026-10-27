import { useEffect, useRef, useState } from "react"

import { prefersReducedMotion } from "@/lib/media"

/** About 30 updates a second: often enough to read as typing, rarely enough to re-render Markdown. */
const FRAME_MS = 33
/** Each frame reveals this share of what's waiting, so a big chunk types out in a second or two. */
const CATCH_UP = 12


/** The end of the word that `index` falls in, so text never stops mid-word. */
function wordEnd(text: string, index: number) {
  if (index >= text.length) return text.length
  const space = text.slice(index).search(/\s/)
  return space < 0 ? text.length : index + space
}

/**
 * Text as it grows, revealed a word at a time. Whatever's there on mount shows at once, so a chat
 * opened later never replays; replaced text (not a continuation) shows at once too.
 */
export function useReveal(text: string) {
  const [length, setLength] = useState(text.length)
  const shown = useRef({ text, length: text.length })

  useEffect(() => {
    const previous = shown.current
    if (!text.startsWith(previous.text.slice(0, previous.length)) || prefersReducedMotion()) {
      shown.current = { text, length: text.length }
      setLength(text.length)
      return
    }
    shown.current = { text, length: previous.length }
    if (previous.length >= text.length) return
    let frame = 0
    let last = 0
    const tick = (now: number) => {
      const current = shown.current
      if (now - last >= FRAME_MS) {
        last = now
        const backlog = text.length - current.length
        const next = wordEnd(text, current.length + Math.max(1, Math.ceil(backlog / CATCH_UP)))
        current.length = next
        setLength(next)
      }
      if (current.length < text.length) frame = requestAnimationFrame(tick)
    }
    frame = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(frame)
  }, [text])

  return text.slice(0, Math.min(length, text.length))
}

import { useEffect, useState } from "react"

import { useReducedMotion } from "@/lib/media"
import { DOTS_MS, ERASE_MS, TYPE_MS, heldLabel, lineText, nextText, typedLabel } from "@/lib/typing"

/**
 * The line under a reply, saying what the turn is doing by typing it: a character every 26ms, and a
 * label the line was already saying rubbed back to the character two labels stop sharing at 12ms — so
 * a turn moving from "Writing" to "Running bash" loses the difference instead of emptying the line.
 * The ellipsis is never typed: the words arrive, then the line grows its dots a step every 500ms, so
 * a turn sitting on one label keeps moving (ADR 0061).
 *
 * A line waiting on the reader is drawn whole and still, because nothing is progressing; where the
 * reader asked for reduced motion the whole label is drawn at once, with the ellipsis it came with.
 *
 * The typed text is not the text announced: characters arriving one at a time are a screen reader's
 * worst case, so the typed span and the dots are hidden from assistive tech and the whole label sits
 * beside them, for the line's own live region to announce once per change. An invisible copy of the
 * widest the line reads holds its box, so whatever follows it on the line — a subagent count — does
 * not slide on every keystroke.
 */
export function TypedLine({ label, waiting }: { label: string; waiting?: boolean }) {
  const reduced = useReducedMotion()
  const whole = Boolean(waiting) || reduced
  const words = typedLabel(label)
  const [shown, setShown] = useState(whole ? words : "")
  const [step, setStep] = useState(0)

  useEffect(() => {
    if (whole || shown === words) return
    const next = nextText(shown, label)
    const arriving = next.length > shown.length
    const timer = setTimeout(() => setShown(next), arriving ? TYPE_MS : ERASE_MS)
    return () => clearTimeout(timer)
  }, [shown, words, label, whole])

  // The dots are the line still moving after it has said its word, never a stand-in for words still
  // arriving: they only cycle once the whole label is in.
  useEffect(() => {
    if (whole || shown !== words) return
    const timer = setInterval(() => setStep((current) => current + 1), DOTS_MS)
    return () => clearInterval(timer)
  }, [shown, words, whole])

  return (
    <span className="relative inline-block min-w-0 max-w-full" data-slot="typed-line">
      <span className="invisible block truncate" aria-hidden data-slot="typed-hold">
        {heldLabel(label)}
      </span>
      <span className="absolute inset-0 truncate" aria-hidden data-slot="typed-words">
        {whole ? label : lineText(shown, label, step)}
      </span>
      <span className="sr-only" data-slot="typed-label">
        {label}
      </span>
    </span>
  )
}

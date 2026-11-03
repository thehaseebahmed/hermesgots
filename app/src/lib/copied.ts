import { useCallback, useEffect, useRef, useState } from "react"
import { toast } from "sonner"

/** Copies text, saying so when the browser refuses: one wording, and one place a refusal is handled. */
export async function copyText(text: string, done?: () => void) {
  try {
    await navigator.clipboard.writeText(text)
    done?.()
  } catch {
    toast.error("Couldn't copy that.")
  }
}

/**
 * The check mark a copy button shows for a moment after a copy. The timer is held and cleared, so a
 * button that unmounts mid-flash doesn't set state on a tree that is gone.
 */
export function useCopied() {
  const [copied, setCopied] = useState(false)
  const timer = useRef<number | undefined>(undefined)
  useEffect(() => () => window.clearTimeout(timer.current), [])
  const noteCopied = useCallback(() => {
    setCopied(true)
    window.clearTimeout(timer.current)
    timer.current = window.setTimeout(() => setCopied(false), 1500)
  }, [])
  return { copied, noteCopied }
}

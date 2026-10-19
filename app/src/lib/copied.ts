import { useCallback, useEffect, useRef, useState } from "react"

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

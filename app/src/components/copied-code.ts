import { useState } from "react"

/**
 * Whether `code` has been copied through, keyed by the code so a new one starts unhandled without an
 * effect. The copy button and the button it unlocks both read this, so neither keeps its own flag.
 */
export function useCopiedCode(code?: string) {
  const [copied, setCopied] = useState<string>()
  return { copied: Boolean(code) && copied === code, noteCopied: () => setCopied(code) }
}

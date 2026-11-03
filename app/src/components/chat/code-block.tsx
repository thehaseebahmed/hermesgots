import { useState } from "react"
import { CheckIcon, CopyIcon } from "lucide-react"

import { useMonoFace } from "@/components/chat/code-face"
import { Button } from "@/components/ui/button"
import { cn } from "@/lib/utils"

/**
 * What the words are drawn on, which decides every colour a block of code needs. The page is the
 * app's own background, so a code fill is `bg-muted` and its chrome the muted grey. A bubble is a
 * filled surface of its own — the user's own words on the primary colour, a queued message on the
 * muted one — where `bg-muted` would sit at the fill's own lightness and a muted-foreground label
 * would vanish into it; there the fill and its chrome are a wash and a shade of the very colour the
 * words are drawn in, which reads on any of them (ADR 0083).
 */
export type Tone = "page" | "fill"

export const PAINT: Record<Tone, { fill: string; chrome: string }> = {
  page: { fill: "bg-muted", chrome: "text-muted-foreground" },
  fill: { fill: "bg-current/15", chrome: "text-current/85" },
}

/**
 * A block of code anywhere the app draws one: a reply's fence, and the command an approval asks
 * about. One piece, so a command reads the same in a card as in the words it came from, and can be
 * taken away with the same press (ADR 0087). `language` names what the block is written in; it is
 * the fence's own label in a reply, and the call's tool in an approval.
 */
export function CodeBlock({
  language,
  code,
  tone = "page",
  scrolling = false,
  className,
}: {
  language?: string
  code: string
  tone?: Tone
  /** A block that would push what follows it off the screen scrolls inside its own box. */
  scrolling?: boolean
  /** The block's own spacing, where it stands in something that already spaces its children. */
  className?: string
}) {
  const [copied, setCopied] = useState(false)
  const mono = useMonoFace()
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(code)
      setCopied(true)
      window.setTimeout(() => setCopied(false), 1500)
    } catch {
      // Clipboard can be unavailable (insecure context); nothing useful to do.
    }
  }

  return (
    <div data-md-code className={cn("my-3 overflow-hidden rounded-2xl", PAINT[tone].fill, className)}>
      <div
        className={cn(
          "flex items-center justify-between pt-1.5 pr-1.5 pl-4 text-xs",
          PAINT[tone].chrome,
        )}
      >
        <span>{language || "code"}</span>
        <Button
          variant="ghost"
          size="icon-sm"
          onClick={copy}
          aria-label={copied ? "Copied" : "Copy code"}
        >
          {copied ? <CheckIcon /> : <CopyIcon />}
        </Button>
      </div>
      <pre
        className={cn(
          mono,
          "px-4 pt-1 pb-4 text-[13px] leading-relaxed wrap-anywhere whitespace-pre-wrap",
          scrolling && "max-h-[30dvh] overflow-y-auto overscroll-contain",
        )}
      >
        <code>{code}</code>
      </pre>
    </div>
  )
}

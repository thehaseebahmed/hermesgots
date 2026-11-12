import type { HTMLAttributes, ReactNode } from "react"
import { CheckIcon, CopyIcon } from "lucide-react"

import { useMonoFace } from "@/components/chat/code-face"
import { Button } from "@/components/ui/button"
import { copyText, useCopied } from "@/lib/copied"
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
 * The measure a source is read at, wherever it is drawn: the code block's `<pre>`, and the body a
 * frame shows in place of a drawing that has yet to land. One constant, so the two cannot drift.
 */
export const SOURCE_TEXT =
  "px-4 pt-1 pb-4 text-[13px] leading-relaxed wrap-anywhere whitespace-pre-wrap"

export function CodeFrame({
  language,
  code,
  tone = "page",
  className,
  children,
  ...root
}: {
  /** What the body is written in: the fence's own label in a reply, the call's tool in an approval. */
  language?: string
  /** The source the control copies, which is what the body draws. */
  code: string
  tone?: Tone
  /** The frame's own spacing, where it stands in something that already spaces its children. */
  className?: string
  children: ReactNode
} & Omit<HTMLAttributes<HTMLDivElement>, "className" | "children">) {
  const { copied, noteCopied } = useCopied()

  return (
    <div {...root} className={cn("my-3 overflow-hidden rounded-2xl", PAINT[tone].fill, className)}>
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
          onClick={() => void copyText(code, noteCopied)}
          aria-label={copied ? "Copied" : "Copy code"}
        >
          {copied ? <CheckIcon /> : <CopyIcon />}
        </Button>
      </div>
      {children}
    </div>
  )
}

/**
 * A block of code anywhere the app draws one: a reply's fence, and the command an approval asks
 * about. One piece, so a command reads the same in a card as in the words it came from, and can be
 * taken away with the same press (ADR 0087).
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
  const mono = useMonoFace()

  return (
    <CodeFrame data-md-code language={language} code={code} tone={tone} className={className}>
      <pre
        className={cn(
          mono,
          SOURCE_TEXT,
          scrolling && "max-h-[30dvh] overflow-y-auto overscroll-contain",
        )}
      >
        <code>{code}</code>
      </pre>
    </CodeFrame>
  )
}

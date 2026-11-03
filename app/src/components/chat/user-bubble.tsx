import type { ComponentProps } from "react"

import { Markdown } from "@/components/chat/markdown"
import { useCodeFace } from "@/components/chat/code-face"
import { Bubble, BubbleContent } from "@/components/ui/bubble"
import { cn } from "@/lib/utils"

/**
 * The bubble the user's own words wear, wherever a thread draws them: the message they sent, the
 * steer that split a reply, and the Moved marker that says where a message went. It is one
 * component because the words are drawn as markdown on the bubble's own fill — the renderer's `fill`
 * tone turns a code span and a fence into a wash of the bubble's text colour, since `bg-muted` under
 * them would be unreadable — and because the bubble keeps `whitespace-pre-wrap` for the renderer's
 * elements to inherit, so the lines someone typed stay broken where they broke them (ADR 0083). The
 * bubble wears the chat's face itself, as well as the renderer putting it on the words: a coding
 * session's face reaches the user's bubbles whether or not a message carries any (ADR 0069).
 */
export function UserBubble({
  children,
  dim = false,
  className,
  ...bubble
}: Omit<ComponentProps<typeof Bubble>, "variant" | "align" | "children"> & {
  children: string
  /** Waiting its turn or waiting to be sent again: the dimmed bubble such a message wears. */
  dim?: boolean
}) {
  const face = useCodeFace()
  return (
    <Bubble
      variant="default"
      align="end"
      className={cn(dim && "opacity-60", className)}
      {...bubble}
    >
      <BubbleContent className={cn("px-4 py-2.5 text-left text-[15px] whitespace-pre-wrap", face)}>
        <Markdown tone="fill">{children}</Markdown>
      </BubbleContent>
    </Bubble>
  )
}

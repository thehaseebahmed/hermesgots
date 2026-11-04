import { lazy, memo, Suspense } from "react"

import { useCodeFace } from "@/components/chat/code-face"
import type { Tone } from "@/components/chat/markdown-renderer"
import { markdownBlocks } from "@/lib/markdown-blocks"
import { cn } from "@/lib/utils"

// Off the startup path, but asked for at once, so it's usually in by the time a reply shows; until
// then a reply shows as plain text.
const load = () => import("@/components/chat/markdown-renderer")
void load()
const MarkdownRenderer = lazy(load)

/** One block, kept while later ones stream in after it. */
const Block = memo(function Block({ text, tone }: { text: string; tone: Tone }) {
  return <MarkdownRenderer tone={tone}>{text}</MarkdownRenderer>
})

export const Markdown = memo(function Markdown({
  children,
  className,
  tone = "page",
}: {
  children: string
  className?: string
  tone?: Tone
}) {
  const face = useCodeFace()
  return (
    <div
      data-slot="markdown"
      data-tone={tone}
      className={cn(
        face,
        "min-w-0 space-y-3 break-words [&_blockquote]:border-l-2 [&_blockquote]:pl-3 [&_blockquote]:italic [&_h1]:text-lg [&_h1]:font-semibold [&_h2]:font-semibold [&_h3]:font-medium [&_li]:my-1 [&_ol]:list-decimal [&_ol]:pl-5 [&_ul]:list-disc [&_ul]:pl-5",
        tone === "fill" && "space-y-2 [&_li]:my-0 [&_ol]:my-0 [&_ol]:pl-4 [&_ul]:my-0 [&_ul]:pl-4",
        // On a bubble the fill inherits `whitespace-pre-wrap`, so the lines someone typed keep their
        // breaks — but react-markdown also leaves a newline between one block and the next, and under
        // pre-wrap that paints as a blank line nobody typed. Normal here, pre-wrap on the elements.
        // The list containers are the exception: react-markdown leaves a newline between one `<li>`
        // and the next inside them, and pre-wrap there paints it as an empty line between bullets —
        // which reads as a gap that no margin explains and no margin can close.
        tone === "fill" && "whitespace-normal [&_*:not(ul):not(ol)]:whitespace-pre-wrap",
        className,
      )}
    >
      <Suspense fallback={<p className="whitespace-pre-wrap">{children}</p>}>
        {markdownBlocks(children).map((text, i) => (
          <Block key={i} text={text} tone={tone} />
        ))}
      </Suspense>
    </div>
  )
})

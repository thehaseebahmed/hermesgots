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
        // On a bubble the fill inherits `whitespace-pre-wrap`, so the lines someone typed keep their
        // breaks — but react-markdown also leaves a newline between one block and the next, and under
        // pre-wrap that paints as a blank line nobody typed. Normal here, pre-wrap on the elements.
        tone === "fill" && "whitespace-normal [&_*]:whitespace-pre-wrap",
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

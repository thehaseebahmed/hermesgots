import { lazy, memo, Suspense } from "react"

import { markdownBlocks } from "@/lib/markdown-blocks"
import { cn } from "@/lib/utils"

// Off the startup path, but asked for at once, so it's usually in by the time a reply shows; until
// then a reply shows as plain text.
const load = () => import("@/components/chat/markdown-renderer")
void load()
const MarkdownRenderer = lazy(load)

/** One block, kept while later ones stream in after it. */
const Block = memo(function Block({ text }: { text: string }) {
  return <MarkdownRenderer>{text}</MarkdownRenderer>
})

export const Markdown = memo(function Markdown({
  children,
  className,
}: {
  children: string
  className?: string
}) {
  return (
    <div
      className={cn(
        "min-w-0 space-y-3 break-words [&_blockquote]:border-l-2 [&_blockquote]:pl-3 [&_blockquote]:italic [&_h1]:text-lg [&_h1]:font-semibold [&_h2]:font-semibold [&_h3]:font-medium [&_li]:my-1 [&_ol]:list-decimal [&_ol]:pl-5 [&_ul]:list-disc [&_ul]:pl-5",
        className,
      )}
    >
      <Suspense fallback={<p className="whitespace-pre-wrap">{children}</p>}>
        {markdownBlocks(children).map((text, i) => (
          <Block key={i} text={text} />
        ))}
      </Suspense>
    </div>
  )
})

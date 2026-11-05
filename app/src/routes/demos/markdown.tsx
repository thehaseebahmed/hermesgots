/**
 * Every element the chat renderer can draw, in one article: a page drawn by the thread's own
 * components at a reply's own measure, so the look has no second copy to keep in step.
 */
import { useState } from "react"

import { Markdown } from "@/components/chat/markdown"
import { CODE_FACE, CodeFaceProvider } from "@/components/chat/code-face"
import { UserBubble } from "@/components/chat/user-bubble"
import { DeveloperOnly } from "@/components/developer-only"
import { DocPage } from "@/components/doc-page"
import { Segmented } from "@/components/segmented"
import { Message, MessageContent } from "@/components/ui/message"
import { Switch } from "@/components/ui/switch"
import { REPLY_EDGE, REPLY_TEXT } from "@/lib/layout"
import { cn } from "@/lib/utils"
import article from "./markdown-article.md?raw"

type Surface = "reply" | "bubble"

const SURFACES = [
  { id: "reply", label: "Reply" },
  { id: "bubble", label: "Bubble" },
] as const

export function MarkdownDemoPage() {
  const [surface, setSurface] = useState<Surface>("reply")
  const [code, setCode] = useState(false)
  return (
    <DeveloperOnly>
      <DocPage title="Markdown" backTo="/" backLabel="Back to chat">
        <div className="flex flex-wrap items-center gap-3 pb-4">
          <div className="min-w-56 flex-1">
            <Segmented
              label="Where the article is drawn"
              options={[...SURFACES]}
              value={surface}
              onChange={setSurface}
            />
          </div>
          <span className="flex items-center gap-2 text-sm text-muted-foreground">
            Code face
            <Switch aria-label="Code face" checked={code} onCheckedChange={setCode} />
          </span>
        </div>
        <CodeFaceProvider value={code ? CODE_FACE : undefined}>
          {surface === "reply" ? (
            <Markdown className={cn(REPLY_EDGE, REPLY_TEXT)}>{article}</Markdown>
          ) : (
            <Message align="end">
              <MessageContent className="items-end gap-1">
                <UserBubble>{article}</UserBubble>
              </MessageContent>
            </Message>
          )}
        </CodeFaceProvider>
      </DocPage>
    </DeveloperOnly>
  )
}

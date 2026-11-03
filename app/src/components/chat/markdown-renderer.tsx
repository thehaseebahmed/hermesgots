import { type ComponentProps, type ReactNode } from "react"
import ReactMarkdown, { defaultUrlTransform } from "react-markdown"
import remarkGfm from "remark-gfm"

import { CodeBlock, PAINT, type Tone } from "@/components/chat/code-block"
import { useMonoFace } from "@/components/chat/code-face"
import { MediaImage } from "@/components/chat/media-image"
import { cn } from "@/lib/utils"

export type { Tone }

function InlineCode({ children, tone }: { children: ReactNode; tone: Tone }) {
  const mono = useMonoFace()
  return (
    <code
      data-md-code
      className={cn(mono, "rounded-md px-1.5 py-0.5 text-[0.85em]", PAINT[tone].fill)}
    >
      {children}
    </code>
  )
}

/** The renderer's components, built once per tone so a block's identity does not change per render. */
const componentsFor = (tone: Tone): ComponentProps<typeof ReactMarkdown>["components"] => ({
  pre: ({ children }) => <>{children}</>,
  img: ({ src, alt }) => <MediaImage src={typeof src === "string" ? src : ""} alt={alt} />,
  code({ className, children }) {
    const match = /language-([\w-]+)/.exec(className ?? "")
    const text = String(children ?? "")
    if (match || text.includes("\n")) {
      return <CodeBlock language={match?.[1]} code={text.replace(/\n$/, "")} tone={tone} />
    }
    return <InlineCode tone={tone}>{children}</InlineCode>
  },
  a: ({ children, href }) => (
    <a href={href} target="_blank" rel="noreferrer" className="underline underline-offset-4">
      {children}
    </a>
  ),
  table: ({ children }) => (
    <div className="my-3 overflow-x-auto">
      <table className="w-full text-left text-sm">{children}</table>
    </div>
  ),
  th: ({ children }) => <th className="border-b px-2 py-1 font-medium">{children}</th>,
  td: ({ children }) => <td className="border-b px-2 py-1">{children}</td>,
})

const COMPONENTS: Record<Tone, ComponentProps<typeof ReactMarkdown>["components"]> = {
  page: componentsFor("page"),
  fill: componentsFor("fill"),
}

// The default transform drops data: URLs, the shape Hermes's chat-completions routes leave an
// agent's image in.
const urlTransform = (url: string) =>
  url.startsWith("data:image/") ? url : defaultUrlTransform(url)

/** The markdown renderer, loaded on its own so the app starts without it. */
export default function MarkdownRenderer({ children, tone }: { children: string; tone: Tone }) {
  return (
    <ReactMarkdown
      remarkPlugins={[remarkGfm]}
      components={COMPONENTS[tone]}
      urlTransform={urlTransform}
    >
      {children}
    </ReactMarkdown>
  )
}

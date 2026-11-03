import { useState, type ComponentProps, type ReactNode } from "react"
import ReactMarkdown, { defaultUrlTransform } from "react-markdown"
import remarkGfm from "remark-gfm"
import { CheckIcon, CopyIcon } from "lucide-react"

import { useMonoFace } from "@/components/chat/code-face"
import { MediaImage } from "@/components/chat/media-image"
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

const PAINT: Record<Tone, { fill: string; chrome: string }> = {
  page: { fill: "bg-muted", chrome: "text-muted-foreground" },
  fill: { fill: "bg-current/15", chrome: "text-current/85" },
}

function CodeBlock({ language, code, tone }: { language?: string; code: string; tone: Tone }) {
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
    <div data-md-code className={cn("my-3 overflow-hidden rounded-2xl", PAINT[tone].fill)}>
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
        )}
      >
        <code>{code}</code>
      </pre>
    </div>
  )
}

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

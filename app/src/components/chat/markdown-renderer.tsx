import { useState, type ComponentProps } from "react"
import ReactMarkdown, { defaultUrlTransform } from "react-markdown"
import remarkGfm from "remark-gfm"
import { CheckIcon, CopyIcon } from "lucide-react"

import { MediaImage } from "@/components/chat/media-image"
import { Button } from "@/components/ui/button"

function CodeBlock({ language, code }: { language?: string; code: string }) {
  const [copied, setCopied] = useState(false)
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
    <div data-md-code className="my-3 overflow-hidden rounded-2xl bg-muted">
      <div className="flex items-center justify-between pt-1.5 pr-1.5 pl-4 text-xs text-muted-foreground">
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
      <pre className="px-4 pt-1 pb-4 font-mono text-[13px] leading-relaxed wrap-anywhere whitespace-pre-wrap">
        <code>{code}</code>
      </pre>
    </div>
  )
}

const components: ComponentProps<typeof ReactMarkdown>["components"] = {
  pre: ({ children }) => <>{children}</>,
  img: ({ src, alt }) => <MediaImage src={typeof src === "string" ? src : ""} alt={alt} />,
  code({ className, children }) {
    const match = /language-(\w+)/.exec(className ?? "")
    const text = String(children ?? "")
    if (match || text.includes("\n")) {
      return <CodeBlock language={match?.[1]} code={text.replace(/\n$/, "")} />
    }
    return (
      <code data-md-code className="rounded-md bg-muted px-1.5 py-0.5 font-mono text-[0.85em]">
        {children}
      </code>
    )
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
}

// The default transform drops data: URLs, the shape Hermes's chat-completions routes leave an
// agent's image in.
const urlTransform = (url: string) =>
  url.startsWith("data:image/") ? url : defaultUrlTransform(url)

/** The markdown renderer, loaded on its own so the app starts without it. */
export default function MarkdownRenderer({ children }: { children: string }) {
  return (
    <ReactMarkdown remarkPlugins={[remarkGfm]} components={components} urlTransform={urlTransform}>
      {children}
    </ReactMarkdown>
  )
}

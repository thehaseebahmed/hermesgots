import { memo, useState, type ComponentProps } from "react"
import ReactMarkdown from "react-markdown"
import remarkGfm from "remark-gfm"
import { CheckIcon, CopyIcon } from "lucide-react"

import { Button } from "@/components/ui/button"
import { cn } from "@/lib/utils"

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
    <div className="my-3 overflow-hidden rounded-2xl bg-background/70 dark:bg-background/40">
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
  code({ className, children }) {
    const match = /language-(\w+)/.exec(className ?? "")
    const text = String(children ?? "")
    if (match || text.includes("\n")) {
      return <CodeBlock language={match?.[1]} code={text.replace(/\n$/, "")} />
    }
    return (
      <code className="rounded-md bg-background/60 px-1.5 py-0.5 font-mono text-[0.85em]">
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
      <ReactMarkdown remarkPlugins={[remarkGfm]} components={components}>
        {children}
      </ReactMarkdown>
    </div>
  )
})

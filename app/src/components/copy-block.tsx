import { useState } from "react"
import { CheckIcon, CopyIcon } from "lucide-react"

import { Button } from "@/components/ui/button"

/** A command or config snippet with a copy button. */
export function CopyBlock({ text, label }: { text: string; label: string }) {
  const [copied, setCopied] = useState(false)
  return (
    <div className="flex items-start gap-2 rounded-2xl bg-muted p-3">
      <pre className="min-w-0 flex-1 font-mono text-xs leading-relaxed break-all whitespace-pre-wrap select-all">
        {text}
      </pre>
      <Button
        variant="ghost"
        size="icon-lg"
        className="-my-1.5 size-11 shrink-0"
        aria-label={label}
        onClick={async () => {
          await navigator.clipboard.writeText(text)
          setCopied(true)
          window.setTimeout(() => setCopied(false), 1500)
        }}
      >
        {copied ? <CheckIcon /> : <CopyIcon />}
      </Button>
    </div>
  )
}

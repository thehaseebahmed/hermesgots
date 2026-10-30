import { Fragment, useEffect, useState, type ReactNode } from "react"
import { useLiveQuery } from "dexie-react-hooks"
import { WrapTextIcon } from "lucide-react"

import { Button } from "@/components/ui/button"
import { getSettings, saveSettings, type ToolEvent } from "@/lib/db"
import { formatTool, splitHtml, type Block } from "@/lib/highlight"
import { exitCode } from "@/lib/tools"
import { cn } from "@/lib/utils"

const INPUT_TITLES: Record<string, string> = {
  terminal: "Command",
  execute_code: "Code",
  browser_exec: "Code",
}
const INPUT_LANGUAGES: Record<string, string> = {
  terminal: "bash",
  execute_code: "python",
  browser_exec: "javascript",
}
/** Tools whose label is a file path, so the output is highlighted as that file. */
const FILE_TOOLS = new Set(["read_file", "write_file", "patch"])

function useFormatted(text: string, hint?: string, omit?: string) {
  const [formatted, setFormatted] = useState<{ text: string; blocks: Block[] }>()
  useEffect(() => {
    let cancelled = false
    void formatTool(text, hint, omit ? [omit] : []).then((blocks) => {
      if (!cancelled) setFormatted({ text, blocks })
    })
    return () => {
      cancelled = true
    }
  }, [text, hint, omit])
  return formatted?.text === text ? formatted.blocks : [{ code: text }]
}

/** Long lines wrap unless turned off; numbered rows keep their number beside each wrapped row. */
function CodeBlock({ block, toggle }: { block: Block; toggle?: boolean }) {
  const wrap = useLiveQuery(async () => (await getSettings()).wrapToolOutput, []) ?? true
  const mono = "font-code"
  const text = wrap ? "whitespace-pre-wrap [overflow-wrap:anywhere]" : "whitespace-pre"
  let body
  if (block.lines) {
    const rows = block.html ? splitHtml(block.html) : block.code.split("\n")
    body = (
      <div
        className={`grid ${wrap ? "grid-cols-[auto_minmax(0,1fr)]" : "w-max min-w-full grid-cols-[auto_max-content]"}`}
      >
        {block.lines.map((line, i) => (
          <Fragment key={i}>
            {/* Sticky, so the numbers stay put while unwrapped lines scroll sideways. */}
            <span
              className="sticky left-0 bg-muted pr-3 pl-4 text-right text-muted-foreground select-none"
              aria-hidden
            >
              {line}
            </span>
            {block.html ? (
              <code className={text} dangerouslySetInnerHTML={{ __html: rows[i] ?? "" }} />
            ) : (
              <code className={text}>{rows[i]}</code>
            )}
          </Fragment>
        ))}
      </div>
    )
  } else {
    body = block.html ? (
      <code className={`block ${text}`} dangerouslySetInnerHTML={{ __html: block.html }} />
    ) : (
      <code className={`block ${text}`}>{block.code}</code>
    )
  }
  return (
    <div className="relative">
      <pre
        className={`overflow-x-auto rounded-2xl bg-muted py-4 ${mono} text-[13px] leading-relaxed ${block.lines ? "" : "pl-4"} ${toggle ? "pr-12" : "pr-4"}`}
      >
        {body}
      </pre>
      {toggle && (
        <Button
          variant="ghost"
          size="icon-lg"
          className="absolute top-0 right-0 size-11 rounded-2xl bg-muted text-muted-foreground aria-pressed:text-foreground"
          aria-label="Wrap lines"
          aria-pressed={wrap}
          onClick={() => void saveSettings({ wrapToolOutput: !wrap })}
        >
          <WrapTextIcon />
        </Button>
      )}
    </div>
  )
}

function Section({
  title,
  text,
  hint,
  omit,
  aside,
  wrapToggle,
}: {
  title: string
  text: string
  hint?: string
  /** A field of the result shown in `aside` instead. */
  omit?: string
  aside?: ReactNode
  wrapToggle?: boolean
}) {
  const blocks = useFormatted(text, hint, omit)
  return (
    <section className="flex flex-col gap-2">
      <div className="flex items-baseline justify-between gap-3 px-1 text-sm text-muted-foreground">
        <h3>{title}</h3>
        {aside}
      </div>
      {blocks.map((block, i) => (
        <CodeBlock key={i} block={block} toggle={wrapToggle} />
      ))}
    </section>
  )
}

export function Details({ tool }: { tool: ToolEvent }) {
  const hasLabel = Boolean(tool.label) && tool.label !== tool.tool
  const code = tool.tool === "terminal" ? exitCode(tool.result) : undefined
  return (
    <>
      {hasLabel && (
        <Section
          title={INPUT_TITLES[tool.tool] ?? "Input"}
          text={tool.label}
          hint={INPUT_LANGUAGES[tool.tool] ?? "plaintext"}
        />
      )}
      {tool.result && (
        <Section
          title="Output"
          wrapToggle
          text={tool.result}
          hint={FILE_TOOLS.has(tool.tool) && hasLabel ? tool.label : undefined}
          omit={code === undefined ? undefined : "exit_code"}
          aside={
            code !== undefined && (
              <span className={cn("tabular-nums", code !== 0 && "text-destructive")}>
                Exit code {code}
              </span>
            )
          }
        />
      )}
    </>
  )
}

import { Fragment } from "react"
import { useLiveQuery } from "dexie-react-hooks"
import { ChevronRightIcon, WrapTextIcon } from "lucide-react"

import { Button } from "@/components/ui/button"
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible"
import { getSettings, saveSettings } from "@/lib/db"
import type { FileChange } from "@/lib/hermes"
import { cn } from "@/lib/utils"

type Row =
  | { kind: "hunk"; text: string }
  | { kind: "context" | "add" | "delete" | "note"; text: string; old?: number; new?: number }

const useWrap = () => useLiveQuery(async () => (await getSettings()).wrapToolOutput, []) ?? true

const HUNK = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/

/** Unified diff hunks as rows numbered on both sides. */
function parsePatch(patch: string): Row[] {
  const rows: Row[] = []
  let old = 0
  let next = 0
  const lines = patch.split("\n")
  if (lines.at(-1) === "") lines.pop()
  for (const line of lines) {
    const hunk = HUNK.exec(line)
    if (hunk) {
      old = Number(hunk[1])
      next = Number(hunk[2])
      rows.push({ kind: "hunk", text: line })
    } else if (line.startsWith("+")) {
      rows.push({ kind: "add", text: line, new: next++ })
    } else if (line.startsWith("-")) {
      rows.push({ kind: "delete", text: line, old: old++ })
    } else if (line.startsWith("\\")) {
      rows.push({ kind: "note", text: line })
    } else {
      rows.push({ kind: "context", text: line, old: old++, new: next++ })
    }
  }
  return rows
}

const ROW_TINT = {
  add: "bg-success/10",
  delete: "bg-destructive/10",
  context: "",
  note: "text-muted-foreground",
}
const NUMBER_TINT = {
  add: "text-success",
  delete: "text-destructive",
  context: "text-muted-foreground",
  note: "text-muted-foreground",
}

function Patch({ patch, wrap }: { patch: string; wrap: boolean }) {
  const rows = parsePatch(patch)
  const digits = String(
    rows.reduce(
      (max, row) =>
        Math.max(max, "old" in row ? (row.old ?? 0) : 0, "new" in row ? (row.new ?? 0) : 0),
      0,
    ),
  ).length
  const text = wrap ? "whitespace-pre-wrap [overflow-wrap:anywhere]" : "whitespace-pre"
  return (
    <pre className="overflow-x-auto py-2 font-mono text-[13px] leading-relaxed">
      <div
        className={cn(
          "grid",
          wrap ? "grid-cols-[auto_minmax(0,1fr)]" : "w-max min-w-full grid-cols-[auto_max-content]",
        )}
      >
        {rows.map((row, i) =>
          row.kind === "hunk" ? (
            <code
              key={i}
              className={cn("col-span-2 bg-foreground/5 px-4 text-muted-foreground", text)}
            >
              {row.text}
            </code>
          ) : (
            <div key={i} className="contents">
              {/* Sticky, so the numbers stay put while unwrapped lines scroll sideways. */}
              <span
                className={cn(
                  "sticky left-0 flex gap-3 bg-muted pr-3 pl-4 select-none",
                  NUMBER_TINT[row.kind],
                )}
                aria-hidden
              >
                <span className="text-right" style={{ width: `${digits}ch` }}>
                  {row.old}
                </span>
                <span className="text-right" style={{ width: `${digits}ch` }}>
                  {row.new}
                </span>
              </span>
              <code className={cn("pr-4", ROW_TINT[row.kind], text)}>{row.text}</code>
            </div>
          ),
        )}
      </div>
    </pre>
  )
}

const STATUS = {
  added: { letter: "A", className: "text-success" },
  deleted: { letter: "D", className: "text-destructive" },
  modified: { letter: "M", className: "text-warning" },
  renamed: { letter: "R", className: "text-muted-foreground" },
}

export function ChangeCounts({
  insertions,
  deletions,
  className,
}: {
  insertions: number
  deletions: number
  className?: string
}) {
  return (
    <span className={cn("shrink-0 font-mono text-xs tabular-nums", className)}>
      <span className="text-success">+{insertions}</span>{" "}
      <span className="text-destructive">−{deletions}</span>
    </span>
  )
}

/** One file's change: a header that folds its unified diff away. */
export function FileDiff({ file, defaultOpen }: { file: FileChange; defaultOpen: boolean }) {
  const wrap = useWrap()
  const status = STATUS[file.status]
  let body
  if (file.patch) body = <Patch patch={file.patch} wrap={wrap} />
  else if (file.binary) body = <Empty>Binary file</Empty>
  else if (file.truncated) body = <Empty>Too big to show</Empty>
  else body = <Empty>No changes to the content</Empty>

  return (
    <Collapsible
      defaultOpen={defaultOpen}
      className="group/file overflow-hidden rounded-2xl bg-muted"
    >
      <CollapsibleTrigger className="flex min-h-12 w-full items-center gap-3 py-2 pr-4 pl-3 text-left outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset">
        <ChevronRightIcon className="size-4 shrink-0 text-muted-foreground transition-transform group-data-[open]/file:rotate-90" />
        <span
          className={cn("w-3 shrink-0 font-mono text-xs font-semibold", status.className)}
          aria-label={file.status}
        >
          {status.letter}
        </span>
        <span className="min-w-0 flex-1 font-mono text-[13px] break-words">
          {file.oldPath && (
            <span className="text-muted-foreground">
              <BreakablePath path={file.oldPath} /> →{" "}
            </span>
          )}
          <BreakablePath path={file.path} />
        </span>
        {!file.binary && <ChangeCounts insertions={file.insertions} deletions={file.deletions} />}
      </CollapsibleTrigger>
      <CollapsibleContent className="border-t border-background">{body}</CollapsibleContent>
    </Collapsible>
  )
}

/** Lets a long path wrap after a slash rather than inside a name. */
function BreakablePath({ path }: { path: string }) {
  return path.split("/").map((part, i) => (
    <Fragment key={i}>
      {i > 0 && (
        <>
          /<wbr />
        </>
      )}
      {part}
    </Fragment>
  ))
}

/** The diff screen's soft-wrap switch; it shares tool output's setting. */
export function WrapToggle() {
  const wrap = useWrap()
  return (
    <Button
      variant="outline"
      size="icon-lg"
      className="size-11 rounded-full text-muted-foreground aria-pressed:text-foreground"
      aria-label="Wrap lines"
      aria-pressed={wrap}
      onClick={() => void saveSettings({ wrapToolOutput: !wrap })}
    >
      <WrapTextIcon />
    </Button>
  )
}

function Empty({ children }: { children: string }) {
  return <p className="px-4 py-3 text-sm text-muted-foreground">{children}</p>
}

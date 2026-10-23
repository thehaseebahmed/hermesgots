import { memo, useEffect, useRef } from "react"
import { Renderer } from "@openuidev/react-lang"

import { Markdown } from "@/components/chat/markdown"
import { INFO } from "@/lib/openui-block.ts"
import type { InterfaceDraw } from "@/lib/openui-thread.ts"
import { noteFailure } from "@/lib/report"

import { library, parser } from "./library.tsx"

type Props = {
  source: string
  open: boolean
  streaming: boolean
  draw: InterfaceDraw["kind"]
}

type Answer = "draw" | "code" | "nothing"

/**
 * The fallback ladder, first match wins. `nothing` while a reply is still writing is what keeps a
 * healthy block's own prefixes (`root`, `root =`, `c = Card("Hi")` all parse to no root) from
 * flashing their fenced source on every flush: only a settled answer may say `code`.
 */
function gate({ source, open, streaming, draw }: Props): { answer: Answer; failure: unknown } {
  if (draw === "patch")
    return open && !streaming
      ? { answer: "code", failure: new Error("a patch's fence never closed in a stopped reply") }
      : { answer: "nothing", failure: undefined }
  if (draw === "orphan") return { answer: "code", failure: new Error("a patch naming nothing") }
  if (open && !streaming)
    return { answer: "code", failure: new Error("a fence that never closed in a stopped reply") }

  let result: ReturnType<typeof parser.parse>
  try {
    result = parser.parse(source)
  } catch (failure) {
    return { answer: "code", failure }
  }
  const { errors } = result.meta
  // `no-root` is a warning when the program calls the root component, and such a program still draws.
  const fatal = errors.some((error) => error.severity !== "warning")
  if (result.root && !fatal) return { answer: "draw", failure: undefined }
  return streaming
    ? { answer: "nothing", failure: undefined }
    : { answer: "code", failure: errors[0] ?? new Error("a settled source with no drawable root") }
}

/** The source re-fenced as `openui-lang`: one backtick longer than its longest run, for Markdown. */
function fenced(source: string) {
  let length = 3
  for (const run of source.match(/`+/g) ?? []) length = Math.max(length, run.length + 1)
  const fence = "`".repeat(length)
  return `${fence}${INFO}\n${source}\n${fence}`
}

function OpenUIBlock(props: Props) {
  const { answer, failure } = gate(props)
  const noted = useRef(false)
  useEffect(() => {
    if (noted.current || props.streaming || answer !== "code") return
    noted.current = true
    noteFailure("openui block", failure)
  }, [props.streaming, answer, failure])
  if (answer === "nothing") return null
  if (answer === "code")
    return <Markdown className="px-1 text-[15px] leading-relaxed">{fenced(props.source)}</Markdown>
  return (
    <Renderer.Root response={props.source} library={library} isStreaming={props.streaming}>
      {/* The text beside a block carries `px-1` (message-item's Markdown); the drawn box carries the
          same inset, so a block starting to draw moves nothing, and its edges land on the text's. */}
      <Renderer.Content className="w-full min-w-0 space-y-3 px-1" />
    </Renderer.Root>
  )
}

export default memo(
  OpenUIBlock,
  (a, b) =>
    a.source === b.source && a.open === b.open && a.streaming === b.streaming && a.draw === b.draw,
)

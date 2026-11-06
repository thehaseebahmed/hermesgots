import { memo, useEffect, useMemo, useRef } from "react"
import { Renderer, type McpClientLike } from "@openuidev/react-lang"

import { Markdown } from "@/components/chat/markdown"
import { REPLY_TEXT } from "@/lib/layout"
import { asLangFence } from "@/lib/openui-block.ts"
import { noteFailure } from "@/lib/report"

import { gate, type Props } from "./gate.ts"

export { blockProblem } from "./gate.ts"
import { appLibrary, appParser, library } from "./library.tsx"

type Literal = { k: string; v?: unknown; els?: Literal[]; entries?: [string, Literal][] }

/** The value a declared literal stands for; anything that is not a plain literal is undefined. */
function literal(node: Literal | undefined): unknown {
  if (!node) return undefined
  if (node.k === "Str" || node.k === "Num" || node.k === "Bool") return node.v
  if (node.k === "Null") return null
  if (node.k === "Arr") return node.els?.map(literal)
  if (node.k === "Obj")
    return Object.fromEntries((node.entries ?? []).map(([key, value]) => [key, literal(value)]))
  return undefined
}

/**
 * The renderer hides a page's content while a read has failed, to draw an error in its place. An
 * app's page declares defaults for exactly that case, so a failed read answers them instead.
 */
function withDefaults(tools: McpClientLike, source: string): McpClientLike {
  const queries = appParser.parse(source).queryStatements
  return {
    async callTool(call) {
      try {
        return await tools.callTool(call)
      } catch (failure) {
        const declared = queries.find(
          (query) =>
            literal(query.toolAST as Literal) === call.name &&
            JSON.stringify(literal(query.argsAST as Literal) ?? {}) ===
              JSON.stringify(call.arguments ?? {}),
        )
        if (!declared?.defaultsAST) throw failure
        return { content: [], structuredContent: literal(declared.defaultsAST as Literal) }
      }
    },
  }
}

function OpenUIBlock(props: Props & { tools?: McpClientLike; app?: boolean }) {
  const { answer, failure } = gate(props, props.app ? appParser : undefined)
  const noted = useRef(false)
  const { app, tools, source } = props
  const provider = useMemo(
    () => (app && tools ? withDefaults(tools, source) : tools),
    [app, tools, source],
  )
  useEffect(() => {
    if (noted.current || props.streaming || answer !== "code") return
    noted.current = true
    noteFailure("openui block", failure)
  }, [props.streaming, answer, failure])
  if (answer === "nothing") return null
  if (answer === "code")
    return <Markdown className={REPLY_TEXT}>{asLangFence(props.source)}</Markdown>
  return (
    <Renderer.Root
      response={props.source}
      library={props.app ? appLibrary : library}
      isStreaming={props.streaming}
      toolProvider={provider}
    >
      <Renderer.Content className="w-full min-w-0 space-y-3" />
    </Renderer.Root>
  )
}

export default memo(
  OpenUIBlock,
  (a, b) =>
    a.source === b.source &&
    a.open === b.open &&
    a.streaming === b.streaming &&
    a.draw === b.draw &&
    a.tools === b.tools &&
    a.app === b.app,
)

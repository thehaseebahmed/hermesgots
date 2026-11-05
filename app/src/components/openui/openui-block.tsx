import { memo, useEffect, useRef } from "react"
import { Renderer } from "@openuidev/react-lang"

import { Markdown } from "@/components/chat/markdown"
import { REPLY_TEXT } from "@/lib/layout"
import { asLangFence } from "@/lib/openui-block.ts"
import { noteFailure } from "@/lib/report"

import { gate, type Props } from "./gate.ts"
import { library } from "./library.tsx"

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
    return <Markdown className={REPLY_TEXT}>{asLangFence(props.source)}</Markdown>
  return (
    <Renderer.Root response={props.source} library={library} isStreaming={props.streaming}>
      <Renderer.Content className="w-full min-w-0 space-y-3" />
    </Renderer.Root>
  )
}

export default memo(
  OpenUIBlock,
  (a, b) =>
    a.source === b.source && a.open === b.open && a.streaming === b.streaming && a.draw === b.draw,
)

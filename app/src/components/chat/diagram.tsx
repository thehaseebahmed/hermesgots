import { CodeBlock, type Tone } from "@/components/chat/code-block"

/**
 * A closed ```mermaid fence, where the fence stood: the tone it sits on, the label it is named by
 * and the copy control that takes its source — all of them the code block's own, since a frame and a
 * block are one piece of chrome around different bodies. Nothing of mermaid is asked for here yet, so
 * the body is the source as it was written; a fence that never closes never reaches this, because the
 * rule leaves it as the code it is, and a reply still streaming fetches nothing.
 */
export function Diagram({ source, tone = "page" }: { source: string; tone?: Tone }) {
  return (
    <CodeBlock
      language="mermaid"
      code={source}
      tone={tone}
      slot="diagram"
      body={
        <div className="px-4 pt-1 pb-4 text-[13px] leading-relaxed wrap-anywhere whitespace-pre-wrap">
          {source}
        </div>
      }
    />
  )
}

import { useEffect, useMemo, useRef, useState, type ReactNode } from "react"

import { Banner } from "@/components/banner"
import { Markdown } from "@/components/chat/markdown"
import { DocPage } from "@/components/doc-page"
import OpenUIBlock from "@/components/openui/openui-block"
import { blockProblem } from "@/components/openui/gate"
import { blockRules, componentRules } from "@/components/openui/prose"
import { referenceEntries } from "@/components/openui/reference"
import { Button } from "@/components/ui/button"
import { Label } from "@/components/ui/label"
import { Textarea } from "@/components/ui/textarea"
import { REPLY_TEXT } from "@/lib/layout"
import { asLangFence, pastedBlock } from "@/lib/openui-block"
import type { ReferenceEntry } from "@/lib/openui-reference"

// Deferred so opening the page does not pull the chart and map chunks or fire tile requests; a DOM
// without an observer (the component tests) mounts everything.
function Reveal({ children }: { children: ReactNode }) {
  const [near, setNear] = useState(() => typeof IntersectionObserver === "undefined")
  const anchor = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const node = anchor.current
    if (near || !node) return
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) setNear(true)
      },
      { rootMargin: "600px" },
    )
    observer.observe(node)
    return () => observer.disconnect()
  }, [near])
  return <div ref={anchor}>{near ? children : <div className="h-56" aria-hidden />}</div>
}

function Entry({ entry }: { entry: ReferenceEntry }) {
  const rules = componentRules(entry.name)
  return (
    <article
      data-reference-entry={entry.name}
      className="border-t border-border pt-8 pb-2 first:border-t-0 first:pt-0"
    >
      <h2 className="text-lg font-semibold tracking-tight">{entry.name}</h2>
      {entry.description && (
        <p className="mt-1 text-sm text-muted-foreground">{entry.description}</p>
      )}
      <div data-reference-drawing className="mt-4">
        {entry.example ? (
          <Reveal>
            <OpenUIBlock source={entry.example} open={false} streaming={false} draw="interface" />
          </Reveal>
        ) : (
          <div data-reference-missing>
            <Banner tone="warning">This component has no drawn example yet.</Banner>
          </div>
        )}
      </div>
      {entry.example && (
        <div data-reference-lang className="mt-4">
          <Markdown className={REPLY_TEXT}>{asLangFence(entry.example)}</Markdown>
        </div>
      )}
      <dl
        data-reference-props
        className="mt-4 grid grid-cols-[max-content_1fr] items-baseline gap-x-4 gap-y-1.5 text-sm"
      >
        {entry.props.map((prop) => (
          <div key={prop.name} className="contents" data-reference-prop={prop.name}>
            <dt className="font-code">{prop.name}</dt>
            <dd className="min-w-0 font-code break-words text-muted-foreground">
              <span data-reference-type>{prop.type}</span>
              <span className="ml-2 font-sans text-xs">
                {prop.required ? "required" : "optional"}
              </span>
            </dd>
          </div>
        ))}
      </dl>
      <p data-reference-parents className="mt-3 text-sm text-muted-foreground">
        {entry.root
          ? "The root of every block"
          : entry.parents.length
            ? `Inside ${entry.parents.join(", ")}`
            : "No block accepts it"}
      </p>
      {rules.length > 0 && (
        <ul data-reference-rules className="mt-2 list-disc space-y-1 pl-5 text-sm">
          {rules.map((rule) => (
            <li key={rule}>{rule}</li>
          ))}
        </ul>
      )}
    </article>
  )
}

// Draws on the button, not per keystroke: a half-typed line is a parse error every time.
function Playground() {
  const [text, setText] = useState("")
  const [drawn, setDrawn] = useState<string | null>(null)
  const source = useMemo(() => (drawn === null ? null : pastedBlock(drawn)), [drawn])
  const problem = useMemo(() => (source === null ? null : blockProblem(source)), [source])

  return (
    <section data-reference-playground className="border-t border-border pt-8">
      <h2 className="text-lg font-semibold tracking-tight">Playground</h2>
      <p className="mt-1 text-sm text-muted-foreground">
        Paste a block and draw it. Nothing is saved and nothing is called.
      </p>
      <Label htmlFor="openui-playground" className="mt-4">
        A block of Lang
      </Label>
      <Textarea
        id="openui-playground"
        value={text}
        onChange={(event) => setText(event.target.value)}
        spellCheck={false}
        rows={10}
        placeholder={'root = Stack([card])\ncard = Card("Hello")'}
        className="mt-2 min-h-48 font-code text-sm"
      />
      <Button className="mt-3" onClick={() => setDrawn(text)} disabled={!text.trim()}>
        Draw
      </Button>
      {source !== null && (
        <div data-reference-result className="mt-4 space-y-3">
          {problem ? (
            <div data-reference-error>
              <Banner tone="warning">{problem}</Banner>
            </div>
          ) : (
            <OpenUIBlock source={source} open={false} streaming={false} draw="interface" />
          )}
          <Markdown className={REPLY_TEXT}>{asLangFence(source)}</Markdown>
        </div>
      )}
    </section>
  )
}

export function OpenUIReferencePage() {
  const entries = referenceEntries()
  return (
    <DocPage title="Component reference" backTo="/settings" backLabel="Back to Settings">
      <ul data-reference-block-rules className="list-disc space-y-1 pl-5 text-sm">
        {blockRules().map((rule) => (
          <li key={rule}>{rule}</li>
        ))}
      </ul>
      <div className="mt-8 space-y-8">
        {entries.map((entry) => (
          <Entry key={entry.name} entry={entry} />
        ))}
      </div>
      <div className="mt-8">
        <Playground />
      </div>
    </DocPage>
  )
}

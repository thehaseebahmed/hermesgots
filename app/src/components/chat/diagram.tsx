import { memo, useEffect, useId, useRef, useState } from "react"

import { CodeBlock, CodeFrame, PAINT, SOURCE_TEXT, type Tone } from "@/components/chat/code-block"
import { Popup, PopupContent, PopupHeader, PopupTitle } from "@/components/popup"
import { DIAGRAM_TOKENS, mermaidTheme, type DiagramPalette } from "@/lib/mermaid-theme"
import { quietly } from "@/lib/report"
import { toHex, useDark } from "@/lib/theme"
import { cn } from "@/lib/utils"

/** A closed ```mermaid fence, drawn where the fence stood, in the code block's own chrome (ADR 0146). */
export const Diagram = memo(function Diagram({
  source,
  tone = "page",
}: {
  source: string
  tone?: Tone
}) {
  const frame = useRef<HTMLDivElement>(null)
  const dark = useDark()
  const [drawing, setDrawing] = useState<Drawing>(WAITING)
  const [open, setOpen] = useState(false)
  // mermaid selects the svg it draws by the id it is handed, so the id has to be a plain DOM id —
  // some React versions answer `useId` with `:r0:`.
  const id = `mermaid-${useId().replace(/[^a-zA-Z0-9]/g, "")}`

  useEffect(() => {
    const element = frame.current
    if (!element) return
    let live = true
    draw(element, id, source, dark, () => live).then(
      (svg) => live && setDrawing({ kind: "drawn", svg }),
      (error) => live && setDrawing({ kind: "failed", line: lineOf(error) }),
    )
    return () => {
      live = false
    }
  }, [dark, id, source])

  if (drawing.kind === "failed")
    return (
      <div className="my-3 space-y-1">
        <CodeBlock language="mermaid" code={source} tone={tone} className="my-0" />
        <p data-slot="diagram-line" className={cn("px-1 text-xs", PAINT[tone].chrome)}>
          {drawing.line}
        </p>
      </div>
    )

  return (
    <div ref={frame} className="my-3">
      <CodeFrame data-slot="diagram" language="mermaid" code={source} tone={tone} className="my-0">
        {drawing.kind === "drawn" ? (
          <button
            type="button"
            data-slot="diagram-drawing"
            aria-label="Open the diagram larger"
            aria-haspopup="dialog"
            aria-expanded={open}
            onClick={() => setOpen(true)}
            className="block w-full cursor-zoom-in appearance-none p-0 text-left outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset"
          >
            <span
              className="block px-4 pt-1 pb-4 [&>svg]:block [&>svg]:h-auto [&>svg]:w-full"
              dangerouslySetInnerHTML={{ __html: drawing.svg }}
            />
          </button>
        ) : (
          <div className={SOURCE_TEXT}>{source}</div>
        )}
      </CodeFrame>
      {drawing.kind === "drawn" ? (
        <Popup open={open} onOpenChange={setOpen}>
          <PopupContent dataSlot="diagram-sheet" bothWays>
            <PopupHeader>
              <PopupTitle>Diagram</PopupTitle>
            </PopupHeader>
            <div className="p-6">
              <div
                style={{ width: widthOf(drawing.svg) || undefined }}
                className="[&>svg]:block [&>svg]:h-auto [&>svg]:w-full"
                dangerouslySetInnerHTML={{ __html: sheetCopy(drawing.svg, id) }}
              />
            </div>
          </PopupContent>
        </Popup>
      ) : null}
    </div>
  )
})

/** The width a drawing was made at, off its own viewBox. */
function widthOf(svg: string) {
  const box = /\sviewBox="\s*-?[\d.]+[\s,]+-?[\d.]+[\s,]+([\d.]+)/.exec(svg)
  return box ? Math.round(Number(box[1])) : 0
}

/** mermaid removes an element by the id it was handed whenever it draws again, so the sheet's copy is renamed. */
const sheetCopy = (svg: string, id: string) => svg.split(id).join(`${id}-sheet`)

type Drawing =
  | { kind: "waiting" }
  | { kind: "drawn"; svg: string }
  | { kind: "failed"; line: string }

const WAITING: Drawing = { kind: "waiting" }

type Mermaid = typeof import("mermaid").default

let loading: Promise<Mermaid> | undefined
function load() {
  loading ??= import("mermaid").then(
    (module) => module.default,
    (error) => {
      // A failed fetch is asked for again by the next diagram, never answered from a cached rejection.
      loading = undefined
      quietly("mermaid's chunk")(error)
      throw error
    },
  )
  return loading
}

let turn: Promise<unknown> = Promise.resolve()
function serially<T>(work: () => Promise<T>): Promise<T> {
  const next = turn.then(work, work)
  turn = next.catch(() => undefined)
  return next
}

async function draw(
  element: HTMLElement,
  id: string,
  source: string,
  dark: boolean,
  live: () => boolean,
) {
  const mermaid = await load()
  return serially(async () => {
    if (!live()) return ""
    mermaid.initialize({
      startOnLoad: false,
      theme: "base",
      darkMode: dark,
      themeVariables: mermaidTheme(paletteOf(element)),
      securityLevel: "strict",
      suppressErrorRendering: true,
    })
    const { svg } = await mermaid.render(id, source)
    return svg
  })
}

function paletteOf(element: HTMLElement): DiagramPalette {
  const style = getComputedStyle(element)
  const tokens: Record<string, string> = {}
  for (const name of DIAGRAM_TOKENS) {
    const value = style.getPropertyValue(`--${name}`).trim()
    if (value) tokens[name] = toHex(value)
  }
  return { surface: surfaceOf(element), ink: toHex(style.color), tokens }
}

function surfaceOf(element: HTMLElement) {
  for (let node: HTMLElement | null = element; node; node = node.parentElement) {
    const colour = toHex(getComputedStyle(node).backgroundColor)
    if (!washed(colour)) return colour
  }
  return toHex(getComputedStyle(document.body).backgroundColor)
}

/** A wash is a colour with an alpha under 1, which is the only time `toHex` prints a fourth pair. */
const washed = (hex: string) => hex.length !== 7

function lineOf(error: unknown) {
  const words = error instanceof Error ? error.message : String(error ?? "")
  const own = words
    .split("\n")
    .map((line) => line.trim())
    .find(Boolean)
  return own && /^parse error/i.test(own) ? own : "Mermaid couldn't draw this diagram."
}

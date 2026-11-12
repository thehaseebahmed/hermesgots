import { memo, useEffect, useId, useRef, useState } from "react"

import { CodeBlock, CodeFrame, PAINT, SOURCE_MEASURE, type Tone } from "@/components/chat/code-block"
import { useMonoFace } from "@/components/chat/code-face"
import { Popup, PopupContent, PopupHeader, PopupTitle } from "@/components/popup"
import { paletteOf } from "@/lib/diagram-palette"
import { failureLine, NotLoaded } from "@/lib/mermaid-failure"
import { mermaidTheme } from "@/lib/mermaid-theme"
import { quietly } from "@/lib/report"
import { useDark } from "@/lib/theme"
import { cn } from "@/lib/utils"

/** A closed ```mermaid fence, drawn where the fence stood, in the code block's own chrome (ADR 0146). */
export const Diagram = memo(function Diagram({
  source,
  tone = "page",
}: {
  source: string
  tone?: Tone
}) {
  // The frame's own plate, not a wrapper around it: the palette reads the surface the drawing really
  // stands on, which for the page tone is the frame's grey and not the page's background.
  const frame = useRef<HTMLDivElement>(null)
  const mono = useMonoFace()
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
    draw({ element, id, source, dark, live: () => live }).then(
      (svg) => live && setDrawing({ kind: "drawn", svg }),
      (error) => live && setDrawing({ kind: "failed", line: failureLine(error) }),
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
    <div className="my-3">
      <CodeFrame
        ref={frame}
        data-slot="diagram"
        language="mermaid"
        code={source}
        tone={tone}
        className="my-0"
      >
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
          // The source in the code face, at the measure a code block reads it at, so the drawing's
          // arrival moves nothing.
          <pre className={cn(mono, SOURCE_MEASURE)}>{source}</pre>
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
      throw new NotLoaded(error)
    },
  )
  return loading
}

/** The renders waiting their turn: mermaid keeps one global config, so two at once would share colours. */
let renderQueue: Promise<unknown> = Promise.resolve()
function serially<T>(work: () => Promise<T>): Promise<T> {
  const next = renderQueue.then(work, work)
  renderQueue = next.catch(() => undefined)
  return next
}

async function draw({
  element,
  id,
  source,
  dark,
  live,
}: {
  element: HTMLElement
  id: string
  source: string
  dark: boolean
  live: () => boolean
}) {
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

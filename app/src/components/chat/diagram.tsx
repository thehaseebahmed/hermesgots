import { memo, useEffect, useId, useRef, useState } from "react"

import { CodeBlock, CodeFrame, PAINT, SOURCE_TEXT, type Tone } from "@/components/chat/code-block"
import { Popup, PopupContent, PopupHeader, PopupTitle } from "@/components/popup"
import { DIAGRAM_TOKENS, mermaidTheme, type DiagramPalette } from "@/lib/mermaid-theme"
import { quietly } from "@/lib/report"
import { toHex, useDark } from "@/lib/theme"
import { cn } from "@/lib/utils"

/**
 * A closed ```mermaid fence, where the fence stood: the tone it sits on, the label it is named by
 * and the copy control that takes its source — all of them the code block's own, since a frame and a
 * block are one piece of chrome around different bodies.
 *
 * The body is a drawing, and mermaid is asked for it on an effect rather than imported at the top:
 * nothing of mermaid is in the entry chunk, and a chunk that fails to arrive takes the same path as a
 * source that will not parse — the source, drawn as the code it is, and one quiet line saying why.
 * Until the chunk lands the source is already on the frame, so a reader never sees it empty and never
 * sees it flash back. A fence that never closes never reaches this at all: the rule leaves it as the
 * code it is, so a reply still streaming fetches nothing.
 *
 * The drawing is a control: a tap — or a keyboard's Enter — opens the app's `Popup` on the same svg at
 * the width it was made, in a body that pans both ways, since a diagram wider than a phone's column
 * is otherwise only ever read scaled down (G6). Nothing is drawn a second time and nothing is asked
 * of mermaid again: the sheet holds the string the frame already has, and closing it leaves the
 * thread exactly where the reader left it.
 */
export const Diagram = memo(function Diagram({
  source,
  tone = "page",
}: {
  source: string
  tone?: Tone
}) {
  const frame = useRef<HTMLDivElement>(null)
  // A theme flip is a redraw: the colours are read off the page when the drawing is made.
  const dark = useDark()
  const [drawing, setDrawing] = useState<Drawing>(WAITING)
  const [open, setOpen] = useState(false)
  // `useId`'s colons (and React 19's guillemets) are no DOM id, and mermaid selects the svg it draws
  // by the id it is handed.
  const id = `mermaid-${useId().replace(/[^a-zA-Z0-9]/g, "")}`

  useEffect(() => {
    const element = frame.current
    if (!element) return
    let live = true
    // Nothing is put back to waiting here: a redraw keeps the drawing it has until the next one
    // lands, so a theme flip never flashes the diagram's source at the reader on its way.
    draw(element, id, source, () => live).then(
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
          // The drawing is the frame's control: a tap or a keyboard's Enter opens it larger. It
          // paints nothing of its own, so the frame's fill is still what it is a picture on.
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
              // mermaid's svg at its own width: it fills the column it stands in and stops at the
              // size it was drawn at, so a narrow diagram is never stretched and a wide one never
              // widens the thread. The sheet is where the full width is read.
              className="block px-4 pt-1 pb-4 [&>svg]:block [&>svg]:h-auto [&>svg]:w-full"
              dangerouslySetInnerHTML={{ __html: drawing.svg }}
            />
          </button>
        ) : (
          // The source, at the measure the code block reads it at, until the drawing replaces it
          // where it stands: a frame is never empty, so a reader sees the fence and not a hole.
          <div className={SOURCE_TEXT}>{source}</div>
        )}
      </CodeFrame>
      {drawing.kind === "drawn" ? (
        <Popup open={open} onOpenChange={setOpen}>
          <PopupContent dataSlot="diagram-sheet" bothWays>
            <PopupHeader>
              <PopupTitle>Diagram</PopupTitle>
            </PopupHeader>
            {/* The drawing at the width it was made, in a body that pans both ways: on a phone that
                is the only way a diagram wider than the column is read at its own size rather than
                scaled into the column the thread already shows. */}
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

/**
 * The width a drawing was made at, off its own viewBox — the size the sheet opens it at. mermaid
 * always writes one; a string without it is left to fill the sheet's box, which is the frame's own
 * rule, rather than given a width guessed from nothing.
 */
function widthOf(svg: string) {
  const box = /\sviewBox="\s*-?[\d.]+[\s,]+-?[\d.]+[\s,]+([\d.]+)/.exec(svg)
  return box ? Math.round(Number(box[1])) : 0
}

/**
 * The drawing as the sheet holds it: the very string the frame drew, its one id given the sheet's
 * own name. mermaid removes an element by the id it was handed whenever it draws again, so a page
 * holding two nodes of one id would have it remove whichever came first — the thread's own drawing.
 * The id is a whole word in that string (its `#id` rules and the ids of its markers all begin with
 * it), so every use of it moves together and the copy is styled by the rules it carries.
 */
const sheetCopy = (svg: string, id: string) => svg.split(id).join(`${id}-sheet`)

type Drawing =
  | { kind: "waiting" }
  | { kind: "drawn"; svg: string }
  | { kind: "failed"; line: string }

/** A frame before its first drawing lands, as one object: every frame starts on the same state. */
const WAITING: Drawing = { kind: "waiting" }

type Mermaid = typeof import("mermaid").default

/** mermaid, asked for once per page: the first drawing fetches the chunk, the rest are handed it. */
let loading: Promise<Mermaid> | undefined
function load() {
  loading ??= import("mermaid").then(
    (module) => module.default,
    (error) => {
      // A chunk that could not be fetched is asked for again by the next diagram: a cached rejection
      // would fail every diagram drawn after the first, on a connection that may have come back.
      loading = undefined
      quietly("mermaid's chunk")(error)
      throw error
    },
  )
  return loading
}

/**
 * One drawing at a time. `initialize` writes mermaid's one global config, so two diagrams drawing at
 * once would each be drawn in the other's colours; and a drawing that failed must not hold the queue
 * the next one waits on.
 */
let turn: Promise<unknown> = Promise.resolve()
function serially<T>(work: () => Promise<T>): Promise<T> {
  const next = turn.then(work, work)
  turn = next.catch(() => undefined)
  return next
}

async function draw(element: HTMLElement, id: string, source: string, live: () => boolean) {
  const mermaid = await load()
  return serially(async () => {
    // A diagram the reader scrolled away from while it waited its turn has nothing to draw, and
    // mermaid would parse and lay out the whole source to paint an element that is no longer on the
    // page.
    if (!live()) return ""
    mermaid.initialize({
      startOnLoad: false,
      theme: "base",
      themeVariables: mermaidTheme(paletteOf(element)),
      // A diagram is a model's markup drawn inside this document: its labels are sanitised.
      securityLevel: "strict",
      // A source mermaid refuses is drawn by the fallback below; its own error graphic is a stack
      // trace with a bomb on it.
      suppressErrorRendering: true,
      // `htmlLabels` is left at mermaid's default (on). A model writes `<br/>` and long labels in its
      // diagrams, and losing that wrapping costs more than the CSS isolation a foreignObject gives
      // up — the SVG is in the app's own document either way.
    })
    const { svg } = await mermaid.render(id, source)
    return svg
  })
}

/**
 * The colours the drawing is made in, read off the element it stands in: the app's tokens are custom
 * properties and inherit down to it, so one read serves every screen. A token the page doesn't answer
 * is left out rather than passed along, for the theme's own fallback to fill.
 */
function paletteOf(element: HTMLElement): DiagramPalette {
  const style = getComputedStyle(element)
  const tokens: Record<string, string> = {}
  for (const name of DIAGRAM_TOKENS) {
    const value = style.getPropertyValue(`--${name}`).trim()
    if (value) tokens[name] = toHex(value)
  }
  return { surface: surfaceOf(element), ink: toHex(style.color), tokens }
}

/**
 * The colour a diagram is a picture on: the first surface painted solid behind it. A frame on a page
 * is filled with the muted plate and a frame in a bubble is a wash of the words' own colour, so the
 * colour a hex can name is the surface under the wash.
 */
function surfaceOf(element: HTMLElement) {
  for (let node: HTMLElement | null = element; node; node = node.parentElement) {
    const colour = getComputedStyle(node).backgroundColor
    if (!washed(colour)) return toHex(colour)
  }
  return toHex(getComputedStyle(document.body).backgroundColor)
}

/**
 * A background that paints nothing of its own: no colour at all, or one with an alpha in it — a
 * `bg-current/15` wash computes as `oklab(… / 0.15)`, and mermaid's colours are hex.
 */
const washed = (colour: string) =>
  !colour || colour === "transparent" || colour.includes("/") || colour.startsWith("rgba(")

/**
 * One quiet line under a source that could not be drawn: mermaid's own words when it refused the
 * source, and one plain sentence when the drawing never arrived — never a stack trace, never a
 * heartbeat.
 */
function lineOf(error: unknown) {
  const words = error instanceof Error ? error.message : String(error ?? "")
  const own = words
    .split("\n")
    .map((line) => line.trim())
    .find(Boolean)
  return own && /^parse error/i.test(own) ? own : "Mermaid couldn't draw this diagram."
}

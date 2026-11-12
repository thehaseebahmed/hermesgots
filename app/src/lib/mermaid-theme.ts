/**
 * A diagram's colours, as mermaid's `base` theme reads them.
 *
 * mermaid is handed hex and nothing else. Its directive sanitiser drops any value that is not a plain
 * colour, so `var(--border)` never arrives, and its colour arithmetic parses hex where the app's own
 * tokens compute to `oklch()` — `toHex` (`lib/theme.ts`) converts each one at the point it is read.
 * The map is written out rather than spread, so a token gaining a name mermaid also uses can never
 * change a diagram's colours by accident.
 *
 * Import-free, so `scripts/test-mermaid-theme.mjs` holds it as a pure rule. A token the page doesn't
 * answer — empty, still a `var(--x)`, or an oklch nothing converted — is met with a shade derived
 * from the two colours the diagram is already drawn in, so no slot is ever `undefined` or blank.
 */

/** The app's tokens a diagram reads, by their name without the leading `--`. */
export const DIAGRAM_TOKENS = [
  "background",
  "foreground",
  "card",
  "muted",
  "muted-foreground",
  "border",
  "accent",
  "warning",
  "destructive",
] as const

export type DiagramTokens = Readonly<Partial<Record<(typeof DIAGRAM_TOKENS)[number], string>>>

export interface DiagramPalette {
  /** The colour the diagram is a picture on: the tone's own surface, as hex. */
  surface: string
  /** The colour its words are drawn in there, as hex. */
  ink: string
  /** The app's tokens as the element it stands in resolves them, in hex where they are colours. */
  tokens: DiagramTokens
}

/** The light page, for a surface nobody could read. */
const PAPER = "#ffffff"
const INK = "#0a0a0a"
const LIGHT_INK = "#fafafa"

const HEX = /^#(?:[0-9a-f]{3}|[0-9a-f]{6})$/i

/** A token as `#rrggbb`, or nothing at all when it is no colour mermaid could parse. */
function read(value: string | undefined) {
  const colour = value?.trim() ?? ""
  if (!HEX.test(colour)) return undefined
  const full = colour.length === 4 ? `#${[...colour.slice(1)].map((c) => c + c).join("")}` : colour
  return full.toLowerCase()
}

/** `ink` mixed into `surface`, `share` percent of the way: mermaid takes one colour per slot. */
function mix(surface: string, ink: string, share: number) {
  const channel = (at: number) => {
    const from = parseInt(surface.slice(at, at + 2), 16)
    const to = parseInt(ink.slice(at, at + 2), 16)
    return Math.round(from + (to - from) * (share / 100))
      .toString(16)
      .padStart(2, "0")
  }
  return `#${channel(1)}${channel(3)}${channel(5)}`
}

/** How light a `#rrggbb` reads, 0 to 1 — roughly, since it only picks words that read on it. */
function light(colour: string) {
  const [r, g, b] = [1, 3, 5].map((at) => parseInt(colour.slice(at, at + 2), 16) / 255)
  return 0.2126 * r + 0.7152 * g + 0.0722 * b
}

/**
 * The app's colours as the variables mermaid's `base` theme reads: one per colour a diagram's boxes,
 * words, connectors, labels, notes and sections are drawn in.
 */
export function mermaidTheme({ surface, ink, tokens }: DiagramPalette): Record<string, string> {
  const on = read(surface) ?? PAPER
  const words = read(ink) ?? (light(on) > 0.5 ? INK : LIGHT_INK)
  const token = (name: keyof DiagramTokens) => read(tokens[name])

  // Each slot: the app's own token where the page answered one, else a shade of the two colours the
  // diagram is drawn in — an outline and a connector are the words mixed into the surface.
  const card = token("card") ?? mix(on, words, 6)
  const plate = token("muted") ?? mix(on, words, 10)
  const edge = token("border") ?? mix(on, words, 22)
  const connector = token("muted-foreground") ?? mix(on, words, 55)
  const accent = token("accent") ?? mix(on, words, 14)
  // A note and an error are tints of the app's own tone rather than the tone itself, so the words on
  // them can be the diagram's ink in either mode.
  const warning = token("warning")
  const note = warning ? mix(on, warning, 22) : mix(on, words, 18)
  const destructive = token("destructive")
  const alert = destructive ? mix(on, destructive, 18) : mix(on, words, 18)

  return {
    background: on,
    // Flowchart: a box, its words and its outline, and the plate a cluster and a label sit on.
    mainBkg: card,
    primaryColor: card,
    primaryTextColor: words,
    primaryBorderColor: edge,
    secondaryColor: plate,
    secondaryTextColor: words,
    secondaryBorderColor: edge,
    tertiaryColor: accent,
    tertiaryTextColor: words,
    tertiaryBorderColor: edge,
    nodeBorder: edge,
    nodeTextColor: words,
    clusterBkg: plate,
    clusterBorder: edge,
    titleColor: words,
    textColor: words,
    lineColor: connector,
    defaultLinkColor: connector,
    edgeLabelBackground: on,
    // Sequence: the actors, the signals between them, and the boxes a step's label sits in.
    actorBkg: card,
    actorBorder: edge,
    actorTextColor: words,
    actorLineColor: edge,
    signalColor: connector,
    signalTextColor: words,
    labelBoxBkgColor: plate,
    labelBoxBorderColor: edge,
    labelTextColor: words,
    loopTextColor: words,
    noteBkgColor: note,
    noteBorderColor: edge,
    noteTextColor: words,
    activationBkgColor: plate,
    activationBorderColor: edge,
    sequenceNumberColor: connector,
    sectionBkgColor: plate,
    altSectionBkgColor: on,
    sectionBkgColor2: plate,
    errorBkgColor: alert,
    errorTextColor: words,
  }
}

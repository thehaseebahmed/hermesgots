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

const PAPER = "#ffffff"
const INK = "#0a0a0a"
const LIGHT_INK = "#fafafa"

const HEX = /^#(?:[0-9a-f]{3}|[0-9a-f]{6}|[0-9a-f]{8})$/i

function read(value: string | undefined) {
  const colour = value?.trim() ?? ""
  if (!HEX.test(colour)) return undefined
  const full = colour.length === 4 ? `#${[...colour.slice(1)].map((c) => c + c).join("")}` : colour
  return full.toLowerCase()
}

const opaque = (colour: string) => colour.slice(0, 7)

const opacity = (colour: string) => (colour.length === 9 ? parseInt(colour.slice(7), 16) / 255 : 1)

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

function light(colour: string) {
  const [r, g, b] = [1, 3, 5].map((at) => parseInt(colour.slice(at, at + 2), 16) / 255)
  return 0.2126 * r + 0.7152 * g + 0.0722 * b
}

/**
 * The app's colours as the variables mermaid's `base` theme reads: one per colour a diagram's boxes,
 * words, connectors, labels, notes and sections are drawn in.
 */
export function mermaidTheme({ surface, ink, tokens }: DiagramPalette): Record<string, string> {
  const on = opaque(read(surface) ?? PAPER)
  const words = opaque(read(ink) ?? (light(on) > 0.5 ? INK : LIGHT_INK))
  const token = (name: keyof DiagramTokens) => {
    const colour = read(tokens[name])
    if (!colour) return undefined
    const alpha = opacity(colour)
    return alpha < 1 ? mix(on, opaque(colour), alpha * 100) : colour
  }

  const card = token("card") ?? mix(on, words, 6)
  const plate = token("muted") ?? mix(on, words, 10)
  const edge = token("border") ?? mix(on, words, 22)
  const connector = token("muted-foreground") ?? mix(on, words, 55)
  const accent = token("accent") ?? mix(on, words, 14)
  const warning = token("warning")
  const note = warning ? mix(on, warning, 22) : mix(on, words, 18)
  const destructive = token("destructive")
  const alert = destructive ? mix(on, destructive, 18) : mix(on, words, 18)

  return {
    background: on,
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

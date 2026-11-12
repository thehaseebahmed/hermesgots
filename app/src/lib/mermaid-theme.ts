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

/** A colour's relative luminance, as WCAG measures it: the ratio below is the same one a contrast check is. */
function luminance(colour: string) {
  const [r, g, b] = [1, 3, 5].map((at) => {
    const channel = parseInt(colour.slice(at, at + 2), 16) / 255
    return channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4
  })
  return 0.2126 * r + 0.7152 * g + 0.0722 * b
}

/** WCAG's ratio for two colours: 1 for a pair that matches, 21 for black on white. */
function contrast(one: string, two: string) {
  const [high, low] = [luminance(one), luminance(two)].sort((a, b) => b - a)
  return (high + 0.05) / (low + 0.05)
}

/** What words have to read at against the surface they are drawn on. */
const READS = 4.5

/** How far off a surface a box is carried when the page's own token doesn't read against its words. */
const SHADE = 6

/**
 * A surface on `on`: the page's token where it reads against `words`, and otherwise a shade of the
 * surface the diagram stands on, carried away from its words until it does. A token is the page's
 * own paper — white in light mode, near-black in dark — which reads on the page's own background and
 * nowhere else: on a filled bubble the same white sits under near-white words at 1.05:1, so the box
 * there is derived from the fill rather than borrowed from the page.
 */
function surfaceColour(on: string, words: string, token: string | undefined) {
  if (token && contrast(token, words) >= READS) return token
  const away = luminance(words) > 0.5 ? "#000000" : "#ffffff"
  for (let share = SHADE; share < 100; share += SHADE) {
    const box = mix(on, away, share)
    if (contrast(box, words) >= READS) return box
  }
  return away
}

/**
 * The app's colours as the variables mermaid's `base` theme reads: one per colour a diagram's boxes,
 * words, connectors, labels, notes and sections are drawn in.
 */
export function mermaidTheme({ surface, ink, tokens }: DiagramPalette): Record<string, string> {
  const on = opaque(read(surface) ?? PAPER)
  const words = opaque(read(ink) ?? (luminance(on) > 0.5 ? INK : LIGHT_INK))
  const token = (name: keyof DiagramTokens) => {
    const colour = read(tokens[name])
    if (!colour) return undefined
    const alpha = opacity(colour)
    return alpha < 1 ? mix(on, opaque(colour), alpha * 100) : colour
  }

  const card = surfaceColour(on, words, token("card"))
  const plate = surfaceColour(on, words, token("muted"))
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

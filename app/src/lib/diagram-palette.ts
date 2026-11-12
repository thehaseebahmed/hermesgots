import { DIAGRAM_TOKENS, type DiagramPalette } from "@/lib/mermaid-theme"
import { toHex } from "@/lib/theme"

/**
 * What a diagram is drawn with, read off the element it will stand in: the colours the app resolves
 * there, and the colour underneath it. One rule for every drawing, so a diagram in a reply, in the
 * user's own bubble and in a sheet all read the surface they really stand on.
 */
export function paletteOf(element: HTMLElement): DiagramPalette {
  const style = getComputedStyle(element)
  const tokens: Record<string, string> = {}
  for (const name of DIAGRAM_TOKENS) {
    const value = style.getPropertyValue(`--${name}`).trim()
    if (value) tokens[name] = toHex(value)
  }
  return { surface: surfaceOf(element), ink: toHex(style.color), tokens }
}

/**
 * The colour the diagram stands on: the first solid fill behind `element`, walked up from the
 * element itself — so the tone's own plate is the surface a page-tone diagram is drawn on, rather
 * than the page's background past it. A wash is walked past, since the fill tone's frame is a wash
 * of the words' own colour and a wash has no colour a drawing could be laid on.
 */
export function surfaceOf(element: HTMLElement) {
  for (let node: HTMLElement | null = element; node; node = node.parentElement) {
    const colour = toHex(getComputedStyle(node).backgroundColor)
    if (!carriesAlpha(colour)) return colour
  }
  return toHex(getComputedStyle(document.body).backgroundColor)
}

/** A colour with an alpha under 1, which is the only time `toHex` prints a fourth pair. */
const carriesAlpha = (hex: string) => hex.length !== 7

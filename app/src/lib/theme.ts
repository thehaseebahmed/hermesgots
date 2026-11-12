import { useTheme } from "next-themes"

/**
 * The three colour modes Settings offers, in the order Appearance draws them, and the label the
 * Settings menu shows for the one in use. One list, so the switch and the row that names it can
 * never disagree.
 */
export const THEMES = [
  { value: "system", label: "System" },
  { value: "light", label: "Light" },
  { value: "dark", label: "Dark" },
] as const

export type ThemeValue = (typeof THEMES)[number]["value"]

/** The label of a stored theme, with anything unset read as following the system. */
export function themeLabel(value: string | undefined) {
  return THEMES.find((theme) => theme.value === (value ?? "system"))?.label ?? THEMES[0].label
}

/**
 * The context every read goes through, made once for the page's life: a canvas per call allocated a
 * bitmap and a context nothing kept, and a diagram reads a dozen tokens each time it draws.
 */
let reader: CanvasRenderingContext2D | null | undefined

/**
 * Computed colours come back as oklch(), which browser chrome may not parse; hex always works. An
 * alpha the colour carries rides along as its fourth pair — dark mode's `--border` is white at a
 * tenth — so whoever reads this can tell a solid colour from a translucent one and mix the second
 * where it draws it.
 */
export function toHex(color: string) {
  if (reader === undefined)
    reader = document.createElement("canvas").getContext("2d", { willReadFrequently: true })
  if (!reader) return color
  // Cleared first: a translucent colour otherwise blends into the pixel the last read left behind.
  reader.clearRect(0, 0, 1, 1)
  reader.fillStyle = color
  reader.fillRect(0, 0, 1, 1)
  const [r, g, b, a] = reader.getImageData(0, 0, 1, 1).data
  const pairs = a === 255 ? [r, g, b] : [r, g, b, a]
  return `#${pairs.map((n) => n.toString(16).padStart(2, "0")).join("")}`
}

/**
 * Whether the app is drawing dark, as next-themes resolved the stored choice: `system` follows the
 * OS, and a page that isn't mounted yet reads as light.
 */
export function useDark() {
  return useTheme().resolvedTheme === "dark"
}

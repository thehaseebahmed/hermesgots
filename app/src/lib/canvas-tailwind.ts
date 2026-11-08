/**
 * The page's own classes, compiled: Tailwind v4 over the tokens the page is handed
 * (`canvas-document.ts`), so a canvas is styled by the app's theme rather than by a copy of it.
 *
 * The compiler runs in the app, not on a build: `tailwindcss/index.css` is self-contained, so the
 * app's copy of it is the base, `CANVAS_THEME` names every token, and the only candidates are the
 * classes the page's markup carries — the guide tells a bot exactly that. Nothing is scanned from
 * disk, so the browser needs no native scanner and the frame gets plain CSS rather than a runtime.
 */

import { compile } from "tailwindcss"

import { TOKENS } from "./canvas-document.ts"

/** Every token but the radius is a colour: it names a `bg-`, `text-` and `border-` utility. */
const COLOURS = TOKENS.filter((token) => token !== "radius")

/**
 * The app's tokens as Tailwind theme variables, inline: a utility carries the token's own
 * `var(--primary)`, so the page follows the mode's theme with no other CSS of ours in the way. The
 * radius is the one token that isn't a colour, so it takes the same four steps the app's own
 * `index.css` gives it.
 *
 * `dark:` is the app's mode, not the phone's: the document puts `.dark` on the page's `html` when the
 * reader has the app in dark, so a variant and the tokens always agree. Tailwind's own `dark`
 * variant asks the operating system, which answers a different question — the app can be forced
 * light on a phone that is dark.
 */
export const CANVAS_THEME = [
  "@custom-variant dark (&:where(.dark, .dark *));",
  "@theme inline {",
  ...COLOURS.map((token) => `  --color-${token}: var(--${token});`),
  "  --radius-sm: calc(var(--radius) * 0.6);",
  "  --radius-md: calc(var(--radius) * 0.8);",
  "  --radius-lg: var(--radius);",
  "  --radius-xl: calc(var(--radius) * 1.4);",
  "}",
].join("\n")

/**
 * The candidates a page asks for: every class its own attributes name, each once, in a stable order.
 *
 * Read off the markup rather than the DOM, since this runs before a page exists: a script's text, a
 * `<style>` block and a comment are not markup. The three ways HTML may write an attribute are read —
 * quoted either way, or bare — and a space written as an entity is a space. A `class=` spelled
 * inside another attribute's value is read as one too, which costs a class the page never wears but
 * never loses one it does.
 */
export function canvasClasses(html: string): string[] {
  const markup = html
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1>/gi, "")
  const found = new Set<string>()
  const attribute = /(?:^|[\s"'/<])class\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'`=<>]+))/gi
  for (const match of markup.matchAll(attribute)) {
    const value = (match[1] ?? match[2] ?? match[3] ?? "").replace(/&#(?:32|x20);|&nbsp;|&Tab;/gi, " ")
    for (const name of value.split(/\s+/)) if (name) found.add(name)
  }
  return [...found].sort()
}

/** The CSS a page's classes compile to: `base` is Tailwind's own stylesheet, the theme is ours. */
export async function compileCanvasCss(base: string, candidates: string[]): Promise<string> {
  const compiler = await compile(`${base}\n${CANVAS_THEME}`, {})
  return compiler.build(candidates)
}

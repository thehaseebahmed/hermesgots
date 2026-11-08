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
 * radius is the one token that isn't a colour, so it is named through the three steps the app's own
 * `rounded-` utilities use.
 */
export const CANVAS_THEME = [
  "@theme inline {",
  ...COLOURS.map((token) => `  --color-${token}: var(--${token});`),
  "  --radius-lg: var(--radius);",
  "  --radius-md: calc(var(--radius) - 2px);",
  "  --radius-sm: calc(var(--radius) - 4px);",
  "}",
].join("\n")

/**
 * The candidates a page asks for: every class its own attributes name, each once, in a stable order.
 *
 * Read off the markup rather than the DOM, since this runs before a page exists: a script's text or
 * a `<style>` block is not markup, and an attribute whose name merely ends in `class` is not a class
 * attribute — either would compile a name for a page that never wears it.
 */
export function canvasClasses(html: string): string[] {
  const markup = html
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1>/gi, "")
  const found = new Set<string>()
  for (const match of markup.matchAll(/(?:^|[\s"'/<])class\s*=\s*(?:"([^"]*)"|'([^']*)')/g))
    for (const name of (match[1] ?? match[2] ?? "").split(/\s+/)) if (name) found.add(name)
  return [...found].sort()
}

/** The CSS a page's classes compile to, over the app's own base and tokens. */
export async function compileCanvasCss(base: string, candidates: string[]): Promise<string> {
  const compiler = await compile(`${base}\n${CANVAS_THEME}`, {})
  return compiler.build(candidates)
}

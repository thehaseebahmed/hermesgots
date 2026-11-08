/**
 * A canvas's compiled classes, kept on this device: the page's markup decides its Tailwind, so the
 * CSS for one version never changes once written, and a canvas opened again — or drawn again after
 * a reload — costs a read rather than a compile.
 *
 * The key is the canvas and the version it was drawn at, which is what a document's CSS is a
 * function of. Rows are kept thirty days and no longer: a canvas is edited, and a version nobody has
 * opened in a month is not one this device needs to stay ready for.
 */

import base from "tailwindcss/index.css?raw"

import { db } from "@/lib/db"
import { canvasClasses, compileCanvasCss } from "@/lib/canvas-tailwind"

const KEEP_MS = 30 * 24 * 60 * 60 * 1000

/** The CSS a canvas's page is drawn with: the one this device compiled for it, else a fresh one. */
export async function canvasCss(id: string, version: number, html: string): Promise<string> {
  const key = `${id}:${version}`
  const held = await db.canvasCss.get(key)
  if (held) return held.css
  const css = await compileCanvasCss(base, canvasClasses(html))
  await db.canvasCss.put({ key, css, at: Date.now() })
  // A prune is housekeeping, so it never fails the draw that asked for it.
  void pruneCanvasCss().catch(() => undefined)
  return css
}

/** Drops the CSS of versions this device hasn't drawn in a month. */
export async function pruneCanvasCss(): Promise<void> {
  await db.canvasCss
    .where("at")
    .below(Date.now() - KEEP_MS)
    .delete()
}

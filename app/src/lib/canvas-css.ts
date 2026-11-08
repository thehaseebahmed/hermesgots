/**
 * A canvas's compiled classes, kept on this device: the page's markup is what its Tailwind is
 * compiled from, so a version's CSS is the same CSS every time this build draws it, and a canvas
 * opened again costs a read rather than a compile.
 *
 * The build is part of the row's name: the compiler and the theme are the app's, so CSS an older
 * build wrote is not CSS this one can hand a page.
 */

import base from "tailwindcss/index.css?raw"

import { db } from "@/lib/db"
import { canvasClasses, compileCanvasCss } from "@/lib/canvas-tailwind"
import { quietly } from "@/lib/report"
import { APP_VERSION } from "@/lib/version"

const KEEP_MS = 30 * 24 * 60 * 60 * 1000

/** The row a canvas version's CSS is kept under, as the screen names it too. */
export function canvasCssKey(id: string, version: number): string {
  return `${id}:${version}:${APP_VERSION}`
}

/** A canvas version's CSS: the one this device compiled for it, else a fresh one, kept. */
export async function canvasCss(id: string, version: number, html: string): Promise<string> {
  const key = canvasCssKey(id, version)
  const held = await db.canvasCss.get(key)
  if (held) return held.css
  const css = await compileCanvasCss(base, canvasClasses(html))
  // Keeping it is a convenience, not the draw: a device out of room still gets its page styled.
  await db.canvasCss.put({ key, css, at: Date.now() }).catch(quietly("Keeping a canvas's classes"))
  void pruneCanvasCss().catch(quietly("Letting a canvas's old classes go"))
  return css
}

/** Drops the rows compiled more than a month ago, which is what keeps the table bounded. */
async function pruneCanvasCss(): Promise<void> {
  await db.canvasCss
    .where("at")
    .below(Date.now() - KEEP_MS)
    .delete()
}

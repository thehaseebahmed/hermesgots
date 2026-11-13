/**
 * The canvas this tab opened (ADR 0151, issue #1051): the flow's own open is the one thing that says
 * a canvas is the app's subject, so a pinned row, an address, a reload, back and forward, and another
 * tab are no mark. Held in the tab's memory and nothing else — a device store would keep a canvas
 * marked for a reader who only visited it, and mark a second tab's canvas in the first.
 */
import { useEffect } from "react"
import { matchPath, useLocation } from "react-router"

import { createStore } from "@/lib/store"

/**
 * The canvas the reader picked on Canvas's own screens — the list's tile, or a start — or `null`,
 * which is every document that has not picked one: a reload, a shared link, another tab.
 */
const opened = createStore<string | null>(null)

/** The flow's open: the reader picked this canvas on Canvas's own screens. */
export const openCanvas = (id: string) => opened.set(id)

/** No canvas is open: the reader left the canvas's screens, which is also a document that has just loaded. */
export const closeCanvas = () => opened.set(null)

/**
 * The canvas a path stands on: its preview, and the edit screen beside it (ADR 0130). Exactly those
 * two addresses — anything else under a canvas's name is no screen the app draws, and is no canvas
 * for the mark.
 */
export function canvasAt(path: string): string | undefined {
  const screen = matchPath("/canvas/:id", path) ?? matchPath("/canvas/:id/edit", path)
  return screen?.params.id
}

/** The one rule a canvas's row is marked by: the canvas on screen is the one this tab opened. */
export function useCanvasOpened(id: string): boolean {
  const open = opened.use()
  const { pathname } = useLocation()
  return open === id && canvasAt(pathname) === id
}

/**
 * Forgets the tab's open canvas once the app is off the canvas's screens, so coming back to it by an
 * address, by back or forward, or by its pinned row marks nothing. The shell calls this: the sidebar
 * is a phone's drawer, and a drawer that is shut runs no effect.
 */
export function useForgetOpenCanvas(pathname: string) {
  // The route alone, not the flag: an open is written on a canvas's screen, so the only commit this
  // has to answer for is a journey off one, and a write that arrives just before its navigation
  // leaves the effect beside it.
  useEffect(() => {
    if (canvasAt(pathname) === undefined) closeCanvas()
  }, [pathname])
}

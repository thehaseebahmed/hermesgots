/**
 * The box a composer's menu hangs in: above the field, as wide as it, with the room above it measured
 * so a phone's keyboard can't push the list off the top of the screen.
 *
 * The measurement is the one the `/` menu has carried since it was written, lifted out whole so the
 * `@` menu measures the same way. What the room is spent on stays with the list inside the box — the
 * list is what scrolls, and the box must not clip the row saying a read is still out.
 *
 * Import-free but for React, so a component test can draw it over a seeded screen.
 */
import { useLayoutEffect, useRef, useState, type ReactNode } from "react"

/** The list's tallest, whatever the screen: the room above the composer caps it below this. */
const MAX_ROOM = 288
/** The least it shrinks to, under three rows, before it gives way to scrolling instead. */
const MIN_ROOM = 132
/** Kept clear above the list, so its first row never sits against the top of the screen. */
const CLEARANCE = 16
/** No more of the screen than this: on a phone with the keyboard up, four rows scroll instead. */
const SCREEN_SHARE = 0.45

/** The box, handing what it measured to the list it holds. */
export function MenuBox({ children }: { children: (room: number) => ReactNode }) {
  const box = useRef<HTMLDivElement>(null)
  const [room, setRoom] = useState(MAX_ROOM)
  // The menu hangs off the composer's top edge, so its lower edge is fixed: what it may be tall is
  // the room above it, and a share of what's on screen — a phone with the keyboard up has little of
  // either, and the list has to give way and scroll rather than run off the top of the screen.
  useLayoutEffect(() => {
    const measure = () => {
      const bottom = box.current?.getBoundingClientRect().bottom
      if (bottom === undefined) return
      // The keyboard isn't part of the layout viewport, so what's visible is the visual one. The
      // floor only lifts the list up to the room there is: it never wins over the measurement, or
      // the first rows would sit above the screen with nothing able to scroll them back.
      const viewport = window.visualViewport
      const visible = viewport?.height ?? window.innerHeight
      const above = bottom - (viewport?.offsetTop ?? 0) - CLEARANCE
      const cap = Math.min(above, visible * SCREEN_SHARE, MAX_ROOM)
      setRoom(Math.max(cap, Math.min(MIN_ROOM, above)))
    }
    measure()
    // The composer grows upward with what it carries (attachment tiles, wrapped text), which moves
    // the room; so does the keyboard, which only the visual viewport hears about. A viewport that
    // moves fires those per frame at most, so the room is read on the frame: one rect a frame while
    // a phone's keyboard or a scroll is moving, however many events arrive inside it.
    let frame = 0
    const soon = () => {
      if (frame) return
      frame = requestAnimationFrame(() => {
        frame = 0
        measure()
      })
    }
    const observer = new ResizeObserver(measure)
    if (box.current?.parentElement) observer.observe(box.current.parentElement)
    window.addEventListener("resize", soon)
    window.visualViewport?.addEventListener("resize", soon)
    window.visualViewport?.addEventListener("scroll", soon)
    return () => {
      cancelAnimationFrame(frame)
      observer.disconnect()
      window.removeEventListener("resize", soon)
      window.visualViewport?.removeEventListener("resize", soon)
      window.visualViewport?.removeEventListener("scroll", soon)
    }
  }, [])

  return (
    <div
      ref={box}
      className="absolute inset-x-0 bottom-full mb-2 overflow-hidden rounded-3xl border bg-popover text-popover-foreground shadow-lg shadow-black/5"
    >
      {children(room)}
    </div>
  )
}

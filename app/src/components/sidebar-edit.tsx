/**
 * The sidebar's edit mode, and the row body both of its states draw.
 *
 * `SidebarEdit` is the mode: one group, labelled for what it is, holding the rows above the boundary
 * and the focus the reader gave it when they opened it. A row in it is no link — a press that
 * navigates while a reader is arranging is how they lose their place — so each row keeps the resting
 * row's 44px height, its label, its pill and its pin's mark, and takes a `data-sidebar-row` naming the
 * id the record files it under.
 *
 * `SidebarRowBody` is what a row shows in either state, held here so the resting sidebar's rows and
 * the mode's cannot drift apart: one label, one pill, one mark. A resting row wraps it in the link
 * that makes it a destination; the mode wraps it in a row that goes nowhere.
 */
import { useEffect, useRef, useState, type PointerEvent as PointerEventOf } from "react"
import {
  AudioLinesIcon,
  ChevronDownIcon,
  ChevronUpIcon,
  CodeXmlIcon,
  FolderKanbanIcon,
  FrameIcon,
  GripVerticalIcon,
  TelescopeIcon,
} from "lucide-react"

import { CanvasMark } from "@/components/canvas-mark"
import { LabLabel } from "@/components/lab-badge"
import type {
  SidebarFeatureId,
  SidebarLayoutRow,
  SidebarMove,
  SidebarPin,
  SidebarPlacedRow,
} from "@/lib/sidebar-layout"
import { cn } from "@/lib/utils"

/**
 * Each feature's mark, by the id the table files it under. Typed by those ids, so a feature added to
 * the table without an icon here fails `pnpm typecheck` rather than drawing a row with no mark.
 */
const FEATURE_ICONS: Record<SidebarFeatureId, typeof FolderKanbanIcon> = {
  projects: FolderKanbanIcon,
  code: CodeXmlIcon,
  canvas: FrameIcon,
  research: TelescopeIcon,
  meetings: AudioLinesIcon,
}

/**
 * A row's move control: the 44px box a press needs, quiet until the row is the reader's to move, and
 * dimmed rather than gone at either end of the list.
 */
const MOVE_CONTROL = cn(
  "flex size-11 shrink-0 items-center justify-center rounded-2xl",
  "text-muted-foreground hover:bg-muted hover:text-foreground",
  "disabled:opacity-40 disabled:hover:bg-transparent disabled:hover:text-muted-foreground",
)

/**
 * A row's mark and name: a feature's icon and its label, or a canvas's own mark and title.
 *
 * A lab feature's name wears the pill that says a switch can take the row away — except in the mode,
 * whose row carries a 44px grip and three 44px controls: on a docked sidebar's 303px the pill leaves
 * the name no width at all, and a name is what a reader arranging the list reads. The word stays in
 * the row for a reader who hears the list, and the resting row still draws the pill.
 */
export function SidebarRowBody<Pin extends SidebarPin & { mark?: string }>({
  row,
  collapsed = false,
  mode = false,
}: {
  row: SidebarLayoutRow<Pin>
  /** The icon rail draws no name: the row's own `aria-label` says it to a reader who hears the list. */
  collapsed?: boolean
  /** The edit mode's row, which holds one more control than the resting row and less room for a pill. */
  mode?: boolean
}) {
  if (row.kind === "pin")
    // A pin's `lab` is the switch its row is drawn under, never a badge: the pill marks the features
    // a switch can take away, and a canvas's row is the canvas's own.
    return (
      <>
        <CanvasMark mark={row.pin.mark} />
        {!collapsed && <span className="min-w-0 truncate">{row.label}</span>}
      </>
    )
  const Icon = FEATURE_ICONS[row.id]
  // A mode's row holds a grip and three more controls, so its name takes what is left and truncates
  // there; the resting row has the width to draw a lab feature's name with its pill beside it.
  const name = (
    <span className="min-w-0 flex-1 truncate">
      {row.label}
      {row.lab && mode && <span className="sr-only">Labs</span>}
    </span>
  )
  return (
    <>
      <Icon className="size-5 text-muted-foreground" />
      {!collapsed && (row.lab && !mode ? <LabLabel fill>{row.label}</LabLabel> : name)}
    </>
  )
}

/**
 * Where a row let go at `y` lands, over the feet of the rows measured at the press: the first row
 * whose foot is still below the pointer — the row it is over — or the last place, where the pointer
 * has been carried below every row. It reads the page's boxes, which only a laid-out page has, so
 * the sweep is where the gesture is proved and this is the arithmetic it proves.
 */
function landingIndex(bottoms: readonly number[], y: number) {
  const over = bottoms.findIndex((bottom) => y < bottom)
  return over === -1 ? bottoms.length - 1 : over
}

/**
 * The mode, open over the sidebar's rows: one group that takes the focus, holding every row above the
 * boundary in the order the sidebar would draw them. A row is a name and a mark, never a destination —
 * a press that navigated while a reader is arranging is how they lose their place.
 *
 * Each row carries the two controls that move it a place up or down, and each feature row the control
 * that puts it away or brings it back, all named for the row and what the press does. A row already
 * put away stays here, in its place and muted, so one list keeps one order and a hidden row is one
 * press from coming back — and still takes part in the order, since a move is a move of the whole
 * list. A pin carries no hide: it left the sidebar because the host pinned it, and only Unpin may end
 * it.
 *
 * A reorder is silent to a reader who cannot see it, so one polite line inside the group says where
 * the row went, and the control that was pressed keeps the focus, so the next press is the next place.
 *
 * Each row also carries a grip, which is the pointer's way to the same placement: a press on it takes
 * the gesture — the pointer is captured, so every move lands on the grip rather than on what it
 * passes over, and `touch-action` is the grip's alone, so the list still scrolls and the drawer still
 * swipes everywhere else — the row lifts, the row whose place it would take is marked, and the release
 * writes the order once. A gesture that is given up — the browser cancelling the pointer, Escape, or a
 * release outside the list — writes nothing at all.
 */
export function SidebarEdit<Pin extends SidebarPin & { mark?: string }>({
  rows,
  onLeave,
  onSetHidden,
  onMove,
  onDrop,
}: {
  rows: readonly SidebarPlacedRow<Pin>[]
  /** Leaves the mode, and is the one way out a reader can take from inside it. */
  onLeave: () => void
  /** Puts one row away, or brings it back: the mode's one write for a hidden row, carried by the account. */
  onSetHidden: (id: string, hidden: boolean) => void
  /** Moves one row a place up or down, over the whole list: the order is the account's. */
  onMove: (id: string, direction: SidebarMove) => void
  /** Puts one row in the place another holds — a drop — over the whole list, as one write. */
  onDrop: (id: string, onto: string) => void
}) {
  const group = useRef<HTMLDivElement>(null)
  const [said, setSaid] = useState("")
  /**
   * The pointer's gesture, as it runs: the pointer it belongs to and the foot of every row as the
   * list stood when the press began. Measured once, at the press, so the marker drawn under the
   * pointer moves nothing the answer is read from.
   */
  const gesture = useRef<{ pointer: number; bottoms: number[] } | null>(null)
  /** The row a reader is carrying, and the place it would land: the index it takes on release. */
  const [drag, setDrag] = useState<{ id: string; label: string; at: number } | null>(null)
  /**
   * The control a press left the focus on, and the place its row stood when it was pressed. The row
   * reaching another place is the render that hands the focus back, since a browser blurs a node
   * moved under the focus it holds.
   */
  const handBack = useRef<{ control: string; id: string; from: number } | null>(null)
  const controls = useRef(new Map<string, HTMLButtonElement>())

  // The mode takes the focus it was opened with, so the next key a reader presses lands in it rather
  // than where the switch left them.
  useEffect(() => {
    group.current?.focus()
  }, [])

  // A move re-renders the list with the row in another place: the control that was pressed takes the
  // focus back once its row has landed, so the next press is the next place.
  useEffect(() => {
    const wait = handBack.current
    if (!wait) return
    if (rows.findIndex(({ row }) => row.id === wait.id) === wait.from) return
    handBack.current = null
    controls.current.get(wait.control)?.focus()
  })

  // Escape is a way out that needs no pointer. It is answered on the document because the mode is a
  // state of the whole sidebar rather than a control's pop-up: whichever part of the list holds the
  // focus, the reader's Escape means this mode.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return
      // A gesture still in the air is what Escape means first: it is given up, nothing is written,
      // and the press after it is the one that leaves the mode.
      if (gesture.current) {
        gesture.current = null
        setDrag(null)
        event.preventDefault()
        return
      }
      onLeave()
    }
    document.addEventListener("keydown", onKey)
    return () => document.removeEventListener("keydown", onKey)
  }, [onLeave])

  /** Keeps a row's control by the row and the way it moves, so the focus can be handed back to it. */
  const keepControl = (control: string) => (node: HTMLButtonElement | null) => {
    if (node) controls.current.set(control, node)
    else controls.current.delete(control)
  }

  const moveRow = (row: SidebarLayoutRow<Pin>, direction: SidebarMove) => {
    const from = rows.findIndex((placed) => placed.row.id === row.id)
    const to = from + direction
    // The ends hold their control, so a press here always has a place to go.
    if (to < 0 || to >= rows.length) return
    handBack.current = { control: `${row.id}:${direction}`, id: row.id, from }
    onMove(row.id, direction)
    // Said in the count the reader sees: the rows the mode draws, which is the list they are arranging.
    setSaid(`${row.label} moved to ${to + 1} of ${rows.length}`)
  }

  /** The foot of every row as the list stands, measured in one pass so no two are a reflow apart. */
  const rowFeet = () =>
    [...(group.current?.querySelectorAll("[data-sidebar-row]") ?? [])].map(
      (node) => node.getBoundingClientRect().bottom,
    )

  /**
   * A press on the grip takes the gesture: the pointer is captured, so every move after it lands
   * here rather than on the rows it passes over, and the browser's own defaults — selecting the
   * row's words, dragging them off, scrolling the list — are the gesture's to skip.
   */
  const beginDrag =
    (row: SidebarLayoutRow<Pin>, at: number) => (event: PointerEventOf<HTMLButtonElement>) => {
      if (event.pointerType === "mouse" && event.button !== 0) return
      event.preventDefault()
      event.currentTarget.setPointerCapture?.(event.pointerId)
      const bottoms = rowFeet()
      // A list with no boxes to measure is no list a pointer has a place over, so the gesture opens
      // nothing rather than guessing one.
      if (!bottoms.length) return
      gesture.current = { pointer: event.pointerId, bottoms }
      setDrag({ id: row.id, label: row.label, at })
    }

  /** Carries the row to the place under the pointer, marked as it goes. */
  const overDrag = (event: PointerEventOf<HTMLButtonElement>) => {
    const held = gesture.current
    if (!held || held.pointer !== event.pointerId) return
    const at = landingIndex(held.bottoms, event.clientY)
    setDrag((was) => (was && was.at !== at ? { ...was, at } : was))
  }

  /**
   * The release: one write, and only where the reader let go of a place. A release outside the list
   * is a gesture given up — the row stands where it stood, and nothing is written.
   */
  const endDrag = (event: PointerEventOf<HTMLButtonElement>) => {
    const held = gesture.current
    if (!held || held.pointer !== event.pointerId) return
    gesture.current = null
    event.currentTarget.releasePointerCapture?.(event.pointerId)
    const drop = drag
    setDrag(null)
    if (!drop) return
    const box = group.current?.getBoundingClientRect()
    const inside =
      box !== undefined &&
      event.clientX >= box.left &&
      event.clientX <= box.right &&
      event.clientY >= box.top &&
      event.clientY <= box.bottom
    const onto = inside ? rows[drop.at] : undefined
    if (!onto || onto.row.id === drop.id) return
    onDrop(drop.id, onto.row.id)
    setSaid(`${drop.label} moved to ${drop.at + 1} of ${rows.length}`)
  }

  /** The browser took the gesture back — a call, a second finger, a scroll it kept: nothing written. */
  const cancelDrag = () => {
    gesture.current = null
    setDrag(null)
  }

  return (
    <div
      ref={group}
      role="group"
      aria-label="Sidebar layout"
      tabIndex={-1}
      className="flex flex-col gap-0.5"
    >
      {rows.map(({ row, hidden }, index) => (
        <div
          key={row.id}
          data-sidebar-row={row.id}
          data-hidden={hidden ? "" : undefined}
          data-canvas-pinned={row.kind === "pin" ? "" : undefined}
          data-dragging={drag?.id === row.id ? "" : undefined}
          // The place the carried row would take: the row standing in it is marked, and the row the
          // reader holds is never marked for itself.
          data-drop-at={drag && drag.at === index && drag.id !== row.id ? "" : undefined}
          className={cn(
            "flex min-h-11 items-center gap-2 rounded-2xl px-3 text-sm",
            hidden && "text-muted-foreground",
            // The lifted row takes the muted surface rather than a shadow: depth is the order of
            // surfaces and one hairline, and a card never floats (DESIGN.md).
            drag?.id === row.id && "relative z-10 bg-muted opacity-60",
            drag &&
              drag.at === index &&
              drag.id !== row.id &&
              "bg-primary/10 ring-2 ring-primary/40 ring-inset",
          )}
        >
          <button
            type="button"
            // The row's grip: the pointer's way into the one placement the Move controls reach too.
            // It is no tab stop and says nothing to a screen reader, since a drag is no key press —
            // those two controls are that path, and they name the row they move.
            tabIndex={-1}
            aria-hidden="true"
            data-sidebar-grip=""
            onPointerDown={beginDrag(row, index)}
            onPointerMove={overDrag}
            onPointerUp={endDrag}
            onPointerCancel={cancelDrag}
            className={cn(
              // The grip is a 44px box around a 16px glyph, so its own air stands in for the gap
              // between it and the row's mark: the name is what the row is short of.
              "-mr-2 flex size-11 shrink-0 cursor-grab touch-none items-center justify-center rounded-2xl",
              "text-muted-foreground hover:bg-muted hover:text-foreground active:cursor-grabbing",
            )}
          >
            <GripVerticalIcon className="size-4" />
          </button>
          <SidebarRowBody row={row} mode />
          {/* The eye reads the muted row; a reader who hears the list needs the word. */}
          {hidden && <span className="sr-only">Hidden</span>}
          <div className="ml-auto flex shrink-0 items-center gap-0.5">
            <button
              type="button"
              ref={keepControl(`${row.id}:-1`)}
              // Named for its row and the place it goes, since "Move up" alone says nothing about
              // which of the list's rows it moves.
              aria-label={`Move ${row.label} up`}
              // Held rather than absent at the ends, so a row's controls never come and go under the
              // reader as the list changes.
              disabled={index === 0}
              onClick={() => moveRow(row, -1)}
              className={MOVE_CONTROL}
            >
              <ChevronUpIcon className="size-4" />
            </button>
            <button
              type="button"
              ref={keepControl(`${row.id}:1`)}
              aria-label={`Move ${row.label} down`}
              disabled={index === rows.length - 1}
              onClick={() => moveRow(row, 1)}
              className={MOVE_CONTROL}
            >
              <ChevronDownIcon className="size-4" />
            </button>
          </div>
          {row.kind === "feature" && (
            <button
              type="button"
              // A name that says what the press does, rather than a pressed state a reader has to work
              // out — which is why this control carries no `aria-pressed`: its words are the state.
              aria-label={`${hidden ? "Show" : "Hide"} ${row.label}`}
              onClick={() => onSetHidden(row.id, !hidden)}
              className={cn(
                "flex h-11 shrink-0 items-center rounded-2xl px-1.5 text-xs font-medium",
                "text-muted-foreground hover:bg-muted hover:text-foreground",
              )}
            >
              {hidden ? "Show" : "Hide"}
            </button>
          )}
        </div>
      ))}
      {/* A reorder is silent to a reader who cannot see the rows move: one polite line says it. */}
      <p role="status" aria-live="polite" className="sr-only">
        {said}
      </p>
    </div>
  )
}

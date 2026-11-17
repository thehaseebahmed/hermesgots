/**
 * The sidebar's edit mode.
 *
 * `SidebarEdit` is the mode: one group, labelled for what it is, holding the rows above the boundary
 * and the focus the reader gave it when they opened it. A row in it is no link — a press that
 * navigates while a reader is arranging is how they lose their place — so each row keeps the resting
 * row's 44px height, its label, its pill and its pin's mark, and takes a `data-sidebar-row` naming the
 * id the record files it under.
 */
import {
  useEffect,
  useRef,
  useState,
  type KeyboardEvent as KeyboardEventOf,
  type PointerEvent as PointerEventOf,
  type ReactNode,
} from "react"
import { EyeIcon, EyeOffIcon, GripVerticalIcon, RotateCcwIcon } from "lucide-react"

import { Refusal } from "@/components/banner"
import { ConfirmDestructive } from "@/components/confirm-destructive"
import { RowGutter, SidebarRowBody } from "@/components/sidebar-row-body"
import { Button } from "@/components/ui/button"
import type {
  SidebarLayoutRow,
  SidebarMove,
  SidebarPin,
  SidebarPinRow,
  SidebarPlacedRow,
} from "@/lib/sidebar-layout"
import { cn } from "@/lib/utils"
import { useRefusal } from "@/lib/use-refusal"

/**
 * The palette every quiet control in the mode wears: the muted ink, the hover that lifts it, and the
 * hover a held control keeps off. The disabled dim is the one value the boxes and the word-buttons
 * do not share (40 against 60, since a word is the only thing a held button still says), so each
 * control names its own — and every class here is still written out, so the build keeps them.
 *
 * The pointer is here because these controls stand on a row that wears the grab cursor the whole of
 * it is a handle by: without it, a press on the eye would offer the drag it does not start.
 */
const QUIET_CONTROL = cn(
  "cursor-pointer text-muted-foreground hover:bg-muted hover:text-foreground",
  "disabled:cursor-default disabled:hover:bg-transparent disabled:hover:text-muted-foreground",
)

/** The one shape a row's word-button takes: the press that lets a canvas go. */
const WORD_CONTROL = cn(
  "flex h-11 shrink-0 items-center rounded-2xl px-1.5 text-xs font-medium",
  QUIET_CONTROL,
  "disabled:opacity-60",
)

/**
 * A row's eye: the 44px box a press needs, quiet until it is pressed. It is an icon and no word, since
 * the mode's row is short and the word the row has no room for is still the press's accessible name.
 */
const EYE_CONTROL = cn(
  "flex size-11 shrink-0 items-center justify-center rounded-2xl",
  QUIET_CONTROL,
  "disabled:opacity-40",
)

/**
 * The mode's foot: the one press that clears the arrangement, drawn as the app's delete control is
 * — 44px, a full radius, an icon inline-start and its words beside it — in the neutral colour a
 * secondary action wears rather than the destructive one. It stands directly under the last row with
 * a small margin and nothing else between them: a rule there drew a line across the mode for a press
 * that is about the list above it, not a section of its own. Held where there is nothing to clear, and
 * never drawn outside the mode.
 */
const RESET_CONTROL = "mx-auto mt-2 h-11 rounded-full"

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

type Drag = { id: string; label: string; at: number }

/**
 * The pointer's half of a row: the whole line takes the press, so a row in the mode is one handle.
 * Captured at the press, every move after it lands on the row rather than on the rows it passes over.
 */
interface RowPress {
  onPointerDown: (event: PointerEventOf<HTMLDivElement>) => void
  onPointerMove: (event: PointerEventOf<HTMLDivElement>) => void
  onPointerUp: (event: PointerEventOf<HTMLDivElement>) => void
  onPointerCancel: () => void
}

/** The keyboard's half: the column's handle, held by its row's id so a move hands the focus back. */
interface Handle {
  /** ArrowUp and ArrowDown, where the handle holds the focus: one place, the way a press moves a row. */
  onKeyDown: (event: KeyboardEventOf<HTMLButtonElement>) => void
  /** Keeps the handle by its row's id, so a move can hand the focus back to it once the row has landed. */
  keep: (node: HTMLButtonElement | null) => void
}

interface RowWiring {
  hidden: boolean
  index: number
  /** The row a reader is carrying, or none: a row reads its own lift and the place it would take. */
  drag: Drag | null
  press: RowPress
  handle: Handle
  /** What the row has to say under it: the mode's refusal, drawn under the row whose press made it. */
  foot?: ReactNode
}

/**
 * A row in the mode, as the list draws it: the lift and the place it would take, and the 44px line
 * the row's own contents stand on. The line is the handle the pointer reaches — a press anywhere on
 * it starts the drag, and the grab cursor says so — while a press on a control inside it is that
 * control's, never a gesture. `foot` is what a row has to say under that line — a refusal is the
 * row's, so the row draws it rather than a notice beside the list.
 */
function RowShell<Pin extends SidebarPin>({
  row,
  hidden,
  index,
  drag,
  press,
  foot,
  children,
}: {
  row: SidebarLayoutRow<Pin>
  hidden: boolean
  index: number
  drag: Drag | null
  press: RowPress
  foot?: ReactNode
  children: ReactNode
}) {
  // Read once, since the attributes and the paint are the same two answers: the row the reader holds,
  // and the row standing in the place it would take — which is never the carried row itself.
  const carrying = drag?.id === row.id
  const landsHere = drag !== null && drag.at === index && !carrying
  return (
    <div
      data-sidebar-row={row.id}
      data-hidden={hidden ? "" : undefined}
      data-canvas-pinned={row.kind === "pin" ? "" : undefined}
      data-dragging={carrying ? "" : undefined}
      data-drop-at={landsHere ? "" : undefined}
      className={cn(
        "flex min-h-11 flex-col rounded-2xl px-3 text-sm",
        hidden && "text-muted-foreground",
        // The lifted row takes the muted surface rather than a shadow: depth is the order of
        // surfaces and one hairline, and a card never floats (DESIGN.md).
        carrying && "relative z-10 bg-muted opacity-60",
        landsHere && "bg-primary/10 ring-2 ring-primary/40 ring-inset",
      )}
    >
      <div
        {...press}
        className="flex min-h-11 cursor-grab items-center gap-3 active:cursor-grabbing"
      >
        {children}
      </div>
      {foot}
    </div>
  )
}

/**
 * A row's grip: the narrow indicator column's glyph, and the one control the order is reached by both
 * ways. A press anywhere on the row takes the pointer's drag — the whole line is the handle, and this
 * glyph is what says so — while ArrowUp and ArrowDown, with this holding the focus, move the row a
 * drawn place through the rule the drop commits through. It is a real tab stop, named for its row — a
 * control that reorders a list is a control a keyboard must be able to reach and a screen reader must
 * be able to hear — and it is 20px wide and 44px tall, the column's own box.
 *
 * `touch-action` is the column's rather than the row's (see `RowGutter`): a finger on the glyph starts
 * a drag, and a finger anywhere else on the row still scrolls the list and swipes the drawer.
 */
function RowHandle<Pin extends SidebarPin>({
  row,
  handle,
}: {
  row: SidebarLayoutRow<Pin>
  handle: Handle
}) {
  const { keep, onKeyDown } = handle
  return (
    <RowGutter>
      <button
        type="button"
        ref={keep}
        aria-label={`Reorder ${row.label}`}
        data-sidebar-grip=""
        onKeyDown={onKeyDown}
        className="flex h-11 w-5 shrink-0 items-center justify-center rounded-2xl text-muted-foreground hover:text-foreground"
      >
        <GripVerticalIcon className="size-3.5" />
      </button>
    </RowGutter>
  )
}

function FeatureModeRow<Pin extends SidebarPin>({
  row,
  wiring,
  onSetHidden,
}: {
  row: SidebarLayoutRow<Pin>
  wiring: RowWiring
  /** Puts the row away, or brings it back, answering with the write's own promise: a refusal is drawn. */
  onSetHidden: (hidden: boolean) => Promise<unknown>
}) {
  const { hidden } = wiring
  return (
    <RowShell
      row={row}
      hidden={hidden}
      index={wiring.index}
      drag={wiring.drag}
      press={wiring.press}
      foot={wiring.foot}
    >
      <RowHandle row={row} handle={wiring.handle} />
      <SidebarRowBody row={row} mode />
      {/* The eye reads the muted row; a reader who hears the list needs the word. */}
      {hidden && <span className="sr-only">Hidden</span>}
      <button
        type="button"
        // A name that says what the press does, rather than a pressed state a reader has to work
        // out — which is why this control carries no `aria-pressed`: its words are the state. The
        // icon is the state drawn: an eye struck through on a row that stands, a plain eye on one
        // that is put away.
        aria-label={`${hidden ? "Show" : "Hide"} ${row.label}`}
        onClick={() => void onSetHidden(!hidden)}
        className={EYE_CONTROL}
      >
        {hidden ? <EyeIcon className="size-4" /> : <EyeOffIcon className="size-4" />}
      </button>
    </RowShell>
  )
}

/**
 * The one control a pin carries — the press that lets its canvas go on the host — and, where the host
 * refused or never answered, its own words under the row with the control one press from asking
 * again.
 *
 * A canvas's record is the host's, so this write is no part of the layout: nothing here touches
 * `sidebarLayout`. An answer folds the host's record into the store, and the row leaves with the
 * store's pinned list; a refusal keeps the row exactly where it stood, since the pin has not moved —
 * only the reader has been told why it can't. Nothing spins and nothing is said in passing: a refusal
 * drawn anywhere but where the press was made is gone before the reader looking there finds it
 * (`confirm-destructive.tsx`'s reason).
 */
function PinModeRow<Pin extends SidebarPin>({
  row,
  wiring,
  onUnpin,
}: {
  row: SidebarPinRow<Pin>
  wiring: RowWiring
  /** Unpins one canvas on its host, answering when the host has — or refusing in its words. */
  onUnpin: (canvasId: string) => Promise<void>
}) {
  const { hidden } = wiring
  const [writing, setWriting] = useState(false)
  // A pin's refusal is the pin's: two canvases failing at once are two sentences, each under its row.
  const refusal = useRefusal(row.pin.id)
  // The control's words and its name both follow what the press does, as Hide and Show's do: a held
  // control that still read "Unpin" would read as one that never answered.
  const words = writing ? "Unpinning" : refusal.words ? "Try again" : "Unpin"
  const name = writing
    ? `Unpinning ${row.label}`
    : refusal.words
      ? `Try again: unpin ${row.label}`
      : `Unpin ${row.label}`

  const unpin = () => {
    // One press, one write: the control is held for as long as the host has it.
    if (writing) return
    setWriting(true)
    // The hold's write: the words it already held go as this one starts, and whatever the host answers
    // draws where the control is. A write that lands takes the row with the store's pinned list.
    void refusal
      .write("unpin this canvas", () => onUnpin(row.pin.id))
      .finally(() => setWriting(false))
  }

  return (
    <RowShell
      row={row}
      hidden={hidden}
      index={wiring.index}
      drag={wiring.drag}
      press={wiring.press}
      // Two writes meet in this row and each says its own: the pin's, under the control that asked
      // its host, and the mode's, under the row whose press moved it.
      foot={
        <>
          {wiring.foot}
          <Refusal hold={refusal} className="mb-1" />
        </>
      }
    >
      <RowHandle row={row} handle={wiring.handle} />
      <SidebarRowBody row={row} mode />
      <button
        type="button"
        data-sidebar-unpin=""
        aria-label={name}
        disabled={writing}
        onClick={unpin}
        className={WORD_CONTROL}
      >
        {words}
      </button>
    </RowShell>
  )
}

/**
 * The mode, open over the sidebar's rows: one group that takes the focus, holding every row above the
 * boundary in the order the sidebar would draw them. A row is a name and a mark, never a destination —
 * a press that navigated while a reader is arranging is how they lose their place.
 *
 * Each row carries the press that puts it away — a feature by hiding it, a pinned canvas by letting
 * its host's pin go — named for the row and what the press does, and drawn as the one control a short
 * row has room for: the eye, which says its state twice, in its struck-through or plain glyph and in
 * the name it is pressed by. A row already put away stays here, in its place and muted, so one list
 * keeps one order and a hidden row is one press from coming back — and still takes part in the order,
 * since a move is a move of the whole list. A pin carries no hide: it left the sidebar because the
 * host pinned it, and only Unpin may end it.
 *
 * A reorder is silent to a reader who cannot see it, so one polite line inside the group says where
 * the row went, and the handle that was pressed keeps the focus, so the next press is the next place.
 *
 * The order is reached two ways, both of them the row's. A press anywhere on a row takes the pointer's
 * gesture — a row in the mode goes nowhere, so the whole of it is the handle, and the column's grip is
 * the glyph that says so: the pointer is captured, so every move lands on the row rather than on what
 * it passes over, the row lifts, the row whose place it would take is marked, and the release writes
 * the order once. A press on a control inside the row is that control's and never a gesture. A finger
 * is the exception the scrolling drawer forces, and the whole reason `touch-action` is the column's:
 * with a touch pointer only the indicator column starts a drag, so a finger on the row still scrolls
 * the drawer. ArrowUp and ArrowDown move the row a drawn place while the column's handle holds the
 * focus. A gesture that is given up — the browser cancelling the pointer, Escape, or a release outside
 * the list — writes nothing at all. Both ways commit through one rule, so a key and a drop cannot
 * disagree.
 *
 * At the foot, directly under the last row with a small margin and no rule between them, stands the
 * one press that clears the whole arrangement: "Reset to default", centred in the mode's width, which
 * asks the app's one question first and, answered, writes the default record. It never asks anything
 * of a canvas, so every pin stays where its host put it.
 */
export function SidebarEdit<Pin extends SidebarPin>({
  rows,
  atDefault,
  onLeave,
  onSetHidden,
  onMove,
  onDrop,
  onUnpin,
  onReset,
}: {
  rows: readonly SidebarPlacedRow<Pin>[]
  /** The record already reads as today's list: there is nothing for the foot's Reset to clear. */
  atDefault: boolean
  /** Leaves the mode, and is the one way out a reader can take from inside it. */
  onLeave: () => void
  /** Puts one row away, or brings it back: the mode's one write for a hidden row, carried by the account. */
  onSetHidden: (id: string, hidden: boolean) => Promise<unknown>
  /** Moves one row a place up or down among the rows the mode draws: the order is the account's. */
  onMove: (id: string, direction: SidebarMove) => Promise<unknown>
  /** Puts one row in the place another holds — a drop — over the whole list, as one write. */
  onDrop: (id: string, onto: string) => Promise<unknown>
  /** Lets one canvas go on its host: the pin's write, and no part of the account's layout. */
  onUnpin: (canvasId: string) => Promise<void>
  /** Writes today's arrangement over the record: the foot's Reset, once its question is answered. */
  onReset: () => Promise<unknown>
}) {
  const group = useRef<HTMLDivElement>(null)
  const [said, setSaid] = useState("")
  /** Whether the foot's question is up: the one press that clears the layout asks before it does. */
  const [asking, setAsking] = useState(false)
  /**
   * The pointer's gesture, as it runs: the pointer it belongs to and the foot of every row as the
   * list stood when the press began. Measured once, at the press, so the marker drawn under the
   * pointer moves nothing the answer is read from.
   */
  const gesture = useRef<{ pointer: number; bottoms: number[] } | null>(null)
  /** The row a reader is carrying, and the place it would land: the index it takes on release. */
  const [drag, setDrag] = useState<Drag | null>(null)
  /**
   * The control a press left the focus on, and the place its row stood when it was pressed. The row
   * reaching another place is the render that hands the focus back, since a browser blurs a node
   * moved under the focus it holds.
   */
  const handBack = useRef<{ control: string; id: string; from: number } | null>(null)
  const controls = useRef(new Map<string, HTMLButtonElement>())

  /**
   * The mode's one hold for its own writes — a row put away or brought back, a row moved — since all
   * of them are the same record's, and one of them refused is one sentence. It is held here rather
   * than in the row a press was made in because a drop is the list's write made from a grip: the row
   * that carries it is whichever one the reader picked up.
   */
  const refusal = useRefusal("layout")
  /** The row the words belong to: drawn under it, so the refusal stands where the press was made. */
  const [refused, setRefused] = useState<string | null>(null)

  /**
   * One layout write, answered where it was pressed. `write` catches the rejection and words it
   * (`useRefusal`), so a device that refused the write — no room, a locked store — is a sentence
   * under the row rather than a rejection nothing hears. A write that lands is not drawn at all.
   */
  const write = (id: string, what: string, action: () => Promise<unknown>) => {
    setRefused(id)
    return refusal.write(what, action)
  }

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
  //
  // The listener is in the capture phase, and stops the press where it answers it. In the phone's
  // drawer this is what makes one press leave the mode and a second close the sheet: Base UI's dialog
  // dismisses on a `keydown` on the document in the bubble phase (`useDismiss`), and on the popup's own
  // `onKeyDown` below it — both downstream of the document's capture, so a press stopped here reaches
  // neither, and the mode's own press is never also the sheet's. The dialog's `onOpenChange` would have
  // been the other place to draw the line, and it is the wrong one: the docked sidebar has no sheet and
  // no `onOpenChange`, so its Escape would have had to be wired through the drawer's, and the sheet's
  // own dismissal would have had to be re-derived from a reason string rather than from the key the
  // reader pressed. Nothing here knows whether a sheet is mounting it.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return
      // The question owns Escape while it stands: that press closes it, and the next one leaves the
      // mode — a reader answering a question is not asking to leave the list behind it. So the press is
      // let through to the question, which owns the key by being the frontmost pop-up.
      if (asking) return
      // A gesture still in the air is what Escape means first: it is given up, nothing is written,
      // and the press after it is the one that leaves the mode.
      if (gesture.current) {
        gesture.current = null
        setDrag(null)
        event.preventDefault()
        event.stopPropagation()
        return
      }
      event.stopPropagation()
      onLeave()
    }
    document.addEventListener("keydown", onKey, true)
    return () => document.removeEventListener("keydown", onKey, true)
  }, [asking, onLeave])

  const keepControl = (control: string) => (node: HTMLButtonElement | null) => {
    if (node) controls.current.set(control, node)
    else controls.current.delete(control)
  }

  /**
   * Where a row went, said in the count the reader sees: the rows the mode draws, which is the list
   * they are arranging. A move and a drop are one sentence, so they cannot come to say it differently.
   */
  const say = (label: string, at: number) =>
    setSaid(`${label} moved to ${at + 1} of ${rows.length}`)

  const moveRow = async (row: SidebarLayoutRow<Pin>, direction: SidebarMove) => {
    const from = rows.findIndex((placed) => placed.row.id === row.id)
    const to = from + direction
    // Either end of the drawn list has no place to go, and nothing is written or said there.
    if (to < 0 || to >= rows.length) return
    handBack.current = { control: row.id, id: row.id, from }
    // The words wait for the write: a move the device refused moved nothing, so it is announced as
    // nothing and the refusal is the row's to draw.
    if (await write(row.id, "move this row", () => onMove(row.id, direction))) {
      say(row.label, to)
    } else {
      handBack.current = null
    }
  }

  /**
   * An arrow on the grip: one place, on the rule the drop commits through (`move`, over `moveTo`'s
   * placement, which is what makes a key and a drag one write). The key is taken either way — at
   * either end there is nowhere to go, and an arrow left to the browser would scroll the list under
   * the row the reader is arranging.
   */
  const stepByKey = (event: KeyboardEventOf<HTMLButtonElement>, row: SidebarLayoutRow<Pin>) => {
    if (event.key !== "ArrowUp" && event.key !== "ArrowDown") return
    event.preventDefault()
    void moveRow(row, event.key === "ArrowUp" ? -1 : 1)
  }

  /** The foot of every row as the list stands, measured in one pass so no two are a reflow apart. */
  const rowFeet = () =>
    [...(group.current?.querySelectorAll("[data-sidebar-row]") ?? [])].map(
      (node) => node.getBoundingClientRect().bottom,
    )

  /**
   * A press on a row takes the gesture: the pointer is captured by the row's own line, so every move
   * after it lands there rather than on the rows it passes over, and the browser's own defaults —
   * selecting the row's words, dragging them off, scrolling the list — are the gesture's to skip.
   *
   * Two presses are not the gesture's. One that lands on a control inside the row is that control's:
   * the eye's, the unpin press's — a press there means what the control says, and a drag that started
   * under it would take the control away from the reader. And a finger, from anywhere but the
   * indicator column: the phone's drawer scrolls and swipes under the finger, so a drag that began at
   * the row's name would cost the reader both. `touch-action` is the column's alone for the same
   * reason, which is why a touch pointer is asked where it landed rather than what it pressed.
   */
  const beginDrag =
    (row: SidebarLayoutRow<Pin>, at: number) => (event: PointerEventOf<HTMLDivElement>) => {
      if (event.pointerType === "mouse" && event.button !== 0) return
      const target = event.target instanceof Element ? event.target : null
      const control = target?.closest("button")
      if (control && !control.hasAttribute("data-sidebar-grip")) return
      if (event.pointerType === "touch" && !target?.closest("[data-sidebar-gutter]")) return
      event.preventDefault()
      event.currentTarget.setPointerCapture?.(event.pointerId)
      const bottoms = rowFeet()
      // A list with no boxes to measure is no list a pointer has a place over, so the gesture opens
      // nothing rather than guessing one.
      if (!bottoms.length) return
      gesture.current = { pointer: event.pointerId, bottoms }
      setDrag({ id: row.id, label: row.label, at })
    }

  const overDrag = (event: PointerEventOf<HTMLDivElement>) => {
    const held = gesture.current
    if (!held || held.pointer !== event.pointerId) return
    const at = landingIndex(held.bottoms, event.clientY)
    setDrag((was) => (was && was.at !== at ? { ...was, at } : was))
  }

  /**
   * The release: one write, and only where the reader let go of a place. A release outside the list
   * is a gesture given up — the row stands where it stood, and nothing is written.
   */
  const endDrag = (event: PointerEventOf<HTMLDivElement>) => {
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
    // The write is the dropped row's, and so is its refusal: a list the device would not keep is the
    // row still where the reader let go of it, with the reason under it.
    void write(drop.id, "move this row", () => onDrop(drop.id, onto.row.id)).then((landed) => {
      if (landed) say(drop.label, drop.at)
    })
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
      {rows.map(({ row, hidden }, index) => {
        // What every row takes from the list it stands in: its place, the gesture, and the two ways
        // into the order the grip holds. One object, so the two kinds of row cannot read the list
        // differently.
        const wiring: RowWiring = {
          hidden,
          index,
          drag,
          press: {
            onPointerDown: beginDrag(row, index),
            onPointerMove: overDrag,
            onPointerUp: endDrag,
            onPointerCancel: cancelDrag,
          },
          handle: {
            onKeyDown: (event) => stepByKey(event, row),
            keep: keepControl(row.id),
          },
          // The mode's own hold, drawn under the row whose press made the write: a row's own control
          // has no notice of its own to draw, and a refusal beside the list is not where the reader
          // is looking.
          foot: refused === row.id ? <Refusal hold={refusal} className="mb-1" /> : undefined,
        }
        return row.kind === "pin" ? (
          <PinModeRow key={row.id} row={row} wiring={wiring} onUnpin={onUnpin} />
        ) : (
          <FeatureModeRow
            key={row.id}
            row={row}
            wiring={wiring}
            onSetHidden={(next) =>
              write(row.id, next ? "hide this row" : "show this row", () =>
                onSetHidden(row.id, next),
              )
            }
          />
        )
      })}
      {/* A reorder is silent to a reader who cannot see the rows move: one polite line says it. */}
      <p role="status" aria-live="polite" className="sr-only">
        {said}
      </p>
      {/* The mode's foot: directly under the last row, with a small margin and no rule — one press
          about the whole list rather than about a row, centred in the mode's own width. Held where
          the record already reads as today's list — there is nothing to clear, and a save of it would
          move the appearance clock for no change (`saveSettings` skips a write whose fields all match,
          but `saveAppearance` carries a new clock with every one). */}
      <Button
        type="button"
        data-sidebar-reset=""
        variant="secondary"
        disabled={atDefault}
        onClick={() => setAsking(true)}
        className={RESET_CONTROL}
      >
        <RotateCcwIcon data-icon="inline-start" />
        Reset to default
      </Button>
      <ConfirmDestructive
        open={asking}
        title="Reset the sidebar?"
        description="Every feature goes back to its usual order, and every row you hid shows again. A pinned canvas stays pinned."
        confirmLabel="Reset"
        onOpenChange={setAsking}
        // The write is the record's own, so the question closes on its answer and never on the press.
        onConfirm={onReset}
      />
    </div>
  )
}

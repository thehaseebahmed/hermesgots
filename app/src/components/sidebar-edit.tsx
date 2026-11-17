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
import { useEffect, useRef } from "react"
import {
  AudioLinesIcon,
  CodeXmlIcon,
  FolderKanbanIcon,
  FrameIcon,
  TelescopeIcon,
} from "lucide-react"

import { CanvasMark } from "@/components/canvas-mark"
import { LabLabel } from "@/components/lab-badge"
import type { SidebarFeatureId, SidebarLayoutRow, SidebarPin } from "@/lib/sidebar-layout"

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

/** A row's mark and name: a feature's icon and its label, or a canvas's own mark and title. */
export function SidebarRowBody<Pin extends SidebarPin & { mark?: string }>({
  row,
  collapsed = false,
}: {
  row: SidebarLayoutRow<Pin>
  /** The icon rail draws no name: the row's own `aria-label` says it to a reader who hears the list. */
  collapsed?: boolean
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
  return (
    <>
      <Icon className="size-5 text-muted-foreground" />
      {/* The pill says what the row's `lab` reports: the rows a switch can take away are the lab's. */}
      {!collapsed && (row.lab ? <LabLabel fill>{row.label}</LabLabel> : row.label)}
    </>
  )
}

/**
 * The mode, open over the sidebar's rows: one group that takes the focus, holding every row above the
 * boundary in the order the sidebar would draw them. A row is a name and a mark, never a destination —
 * a press that navigated while a reader is arranging is how they lose their place.
 */
export function SidebarEdit<Pin extends SidebarPin & { mark?: string }>({
  rows,
  onLeave,
}: {
  rows: readonly SidebarLayoutRow<Pin>[]
  /** Leaves the mode, and is the one way out a reader can take from inside it. */
  onLeave: () => void
}) {
  const group = useRef<HTMLDivElement>(null)

  // The mode takes the focus it was opened with, so the next key a reader presses lands in it rather
  // than where the switch left them.
  useEffect(() => {
    group.current?.focus()
  }, [])

  // Escape is a way out that needs no pointer. It is answered on the document because the mode is a
  // state of the whole sidebar rather than a control's pop-up: whichever part of the list holds the
  // focus, the reader's Escape means this mode.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onLeave()
    }
    document.addEventListener("keydown", onKey)
    return () => document.removeEventListener("keydown", onKey)
  }, [onLeave])

  return (
    <div
      ref={group}
      role="group"
      aria-label="Sidebar layout"
      tabIndex={-1}
      className="flex flex-col gap-0.5"
    >
      {rows.map((row) => (
        <div
          key={row.id}
          data-sidebar-row={row.id}
          data-canvas-pinned={row.kind === "pin" ? "" : undefined}
          className="flex min-h-11 items-center gap-3 rounded-2xl px-3 text-sm"
        >
          <SidebarRowBody row={row} />
        </div>
      ))}
    </div>
  )
}

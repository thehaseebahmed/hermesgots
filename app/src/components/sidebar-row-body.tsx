/**
 * What a sidebar row shows in either state, so the resting sidebar's rows and the mode's cannot
 * drift apart: one label, one pill, one mark. A resting row wraps it in the link that makes it a
 * destination; the mode wraps it in a row that goes nowhere.
 *
 * Its own file because both draw it: held in the mode's file, the resting sidebar's rows changed
 * whenever the mode did.
 */
import type { ReactNode } from "react"
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
 * The narrow column every sidebar row starts with, in either state: 12px of it — a hairline, since a
 * column is only a place for the mode's grip to stand and a mark does not want the room — down the
 * row's whole height, empty at rest and holding the grip while the reader is arranging.
 *
 * Kept on every row — a feature, a pinned canvas, a session waiting on the reader, a bot — so that a
 * mark or a face starts at the same x whatever kind of row it is and whether the mode is open or shut.
 * The icon rail draws none: its row is a 44px box whose mark is the row, and the rail has no mode.
 *
 * `touch-action: none` is this column's alone, and only in the mode: a finger here starts a drag,
 * while a finger anywhere else on the row still scrolls the list and swipes the drawer.
 */
export function RowGutter({ children }: { children?: ReactNode }) {
  return (
    <span
      data-sidebar-gutter=""
      // Hidden while it stands empty; in the mode it is the grip's own box, and a focusable control
      // inside a hidden element is a control no one can hear.
      aria-hidden={children ? undefined : true}
      className={cn(
        "flex w-3 shrink-0 items-center justify-center self-stretch",
        children && "touch-none",
      )}
    >
      {children}
    </span>
  )
}

/**
 * A row's mark and name: a feature's icon and its label, or a canvas's own mark and title.
 *
 * A lab feature's name wears the pill that says a switch can take the row away — except in the mode,
 * whose row carries a narrow grip and the eye beside it: on a docked sidebar's 303px the pill leaves
 * the name no width at all, and a name is what a reader arranging the list reads. The word stays in the
 * row for a reader who hears the list, and the resting row still draws the pill.
 */
export function SidebarRowBody<Pin extends SidebarPin>({
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

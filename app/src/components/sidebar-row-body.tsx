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
 * The 44px slot a row above the boundary starts with, in either state: empty and hidden from a screen
 * reader at rest, holding the mode's grip while the reader is arranging.
 *
 * Reserved in both states, so opening and closing the mode moves nothing — the mark, the name and the
 * row's own height stand where they stood either way. The icon rail draws none (its row is a 44px box
 * whose mark is the row), and nothing below the boundary is arranged, so nothing below it reserves one.
 */
export function RowGutter({ children }: { children?: ReactNode }) {
  return (
    <span
      data-sidebar-gutter=""
      // Hidden while it stands empty; in the mode it is the grip's own box, and a focusable control
      // inside a hidden element is a control no one can hear.
      aria-hidden={children ? undefined : true}
      className="flex size-11 shrink-0 items-center justify-center"
    >
      {children}
    </span>
  )
}

/**
 * A row's mark and name: a feature's icon and its label, or a canvas's own mark and title.
 *
 * A lab feature's name wears the pill that says a switch can take the row away — except in the mode,
 * whose row carries a 44px grip and the eye beside it: on a docked sidebar's 303px the pill leaves the
 * name no width at all, and a name is what a reader arranging the list reads. The word stays in the
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

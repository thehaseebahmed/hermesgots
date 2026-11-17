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
 * The narrow column the mode's rows start with: 12px of it — a hairline, since a column is only a
 * place for the grip to stand and a mark does not want the room — down the row's whole height.
 *
 * Only the mode has one. At rest the column is not drawn at all, so the sidebar keeps exactly the
 * spacing it shipped with; `open` tweens it in from zero when the mode opens and back to zero when it
 * closes. That tween is what makes the mode's arrival seamless: at zero the column costs nothing —
 * its width is 0 and its negative margin cancels the row's gap — so the row's mark sits exactly where
 * the resting row's does, and a row remounted at either end of the transition looks unchanged
 * (transitions.dev's card resize, on the app's own curve).
 *
 * `touch-action: none` is this column's alone, and only while the grip stands at full width: a finger
 * here starts a drag, while a finger anywhere else on the row still scrolls the list and swipes the
 * drawer.
 */
export function RowGutter({
  open = false,
  children,
}: {
  /** Full width, or closed: the row reads the same at zero as it does at rest. */
  open?: boolean
  children?: ReactNode
}) {
  return (
    <span
      data-sidebar-gutter=""
      data-open={open ? "" : undefined}
      className={cn(
        "flex shrink-0 items-center justify-center self-stretch overflow-hidden",
        "transition-[width,margin] duration-300 ease-[cubic-bezier(0.2,0,0,1)] motion-reduce:transition-none",
        // At zero the column is a hairline of nothing, and the gap beside it is paid back so the mark
        // does not stand 8px in on a row that is not being arranged.
        open ? "w-3" : "-mr-2 w-0",
        open && "touch-none",
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

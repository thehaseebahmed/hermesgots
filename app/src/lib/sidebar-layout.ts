/**
 * The sidebar's rows above the boundary, as one table: the features this build draws, in the order it
 * draws them, and then the canvases the reader pinned to their foot.
 *
 * Each entry names its own id, label and address, and **reports** the lab switch the row needs rather
 * than applying it. A row a switch has taken away is still a row this build knows, which is what keeps
 * an edit made with a lab off from dropping that row out of the account's record.
 *
 * The icons are the drawing component's, so this holds no JSX and imports nothing:
 * `scripts/test-sidebar-layout.mjs` runs it as a pure rule.
 */

/** The lab switches a row can need. `canvas` is also what a pin needs, since a pin is a canvas. */
export type SidebarLab = "canvas" | "meetings"

/**
 * Today's sidebar, top to bottom: the one place the features, their labels and their order live.
 * `end` is the address being the whole screen, so an address under it is no row of this one.
 */
export const SIDEBAR_FEATURES = [
  { id: "projects", label: "Projects", address: "/projects", lab: null, end: false },
  { id: "code", label: "Code", address: "/code", lab: null, end: false },
  { id: "canvas", label: "Canvas", address: "/canvas", lab: "canvas", end: true },
  { id: "research", label: "Research", address: "/research", lab: null, end: false },
  { id: "meetings", label: "Meetings", address: "/meetings", lab: "meetings", end: false },
] as const

/** The features this build knows, by the id each row is filed under. */
export type SidebarFeatureId = (typeof SIDEBAR_FEATURES)[number]["id"]

/** What a row needs of a pinned canvas: the id it is filed under, and the title it is drawn with. */
export interface SidebarPin {
  id: string
  title: string
}

/** One row: a feature's screen, or the canvas the reader pinned. */
export type SidebarLayoutRow<Pin extends SidebarPin = SidebarPin> =
  SidebarFeatureRow | SidebarPinRow<Pin>

/** A feature's row: what the table says about it, and the kind of row it is. */
type SidebarFeatureRow = (typeof SIDEBAR_FEATURES)[number] & { kind: "feature" }

interface SidebarPinRow<Pin extends SidebarPin> {
  kind: "pin"
  /**
   * `canvas:<id>`, never a feature's own id: a canvas called `code` and the feature Code would
   * otherwise be one row in the record. The prefix is the record's, so it is written here alone.
   */
  id: string
  label: string
  address: string
  /** A pin is a canvas, so the switch it needs is Canvas's — the one its rows are drawn under. */
  lab: "canvas"
  pin: Pin
}

const CANVAS_ROW = "canvas:"

/** The rows the sidebar draws, in order: the features, then the pins the reader keeps. */
export function sidebarRows<Pin extends SidebarPin>(
  pins: readonly Pin[] = [],
): SidebarLayoutRow<Pin>[] {
  return [
    ...SIDEBAR_FEATURES.map((feature): SidebarLayoutRow<Pin> => ({ kind: "feature", ...feature })),
    ...pins.map((pin): SidebarLayoutRow<Pin> => ({
      kind: "pin",
      id: `${CANVAS_ROW}${pin.id}`,
      label: pin.title,
      address: `/canvas/${pin.id}`,
      lab: "canvas",
      pin,
    })),
  ]
}

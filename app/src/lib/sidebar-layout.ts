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

/**
 * The sidebar's arrangement, as the account carries it: the rows the reader put away, and the rows
 * above the boundary in the order they are drawn.
 */
export interface SidebarLayoutRecord {
  /** The shape's own number, so a build whose shape differs can tell a record it does not know. */
  version: 1
  /** The rows the reader put away, by id. */
  hidden: string[]
  /** Every row above the boundary in its drawn order, a pinned canvas as `canvas:<id>`. */
  order: string[]
}

/** Today's arrangement: nothing hidden, and the order the table draws. */
export const DEFAULT_SIDEBAR_LAYOUT: SidebarLayoutRecord = { version: 1, hidden: [], order: [] }

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

/** A row as the account's record leaves it: the row the table draws, and whether the reader put it away. */
export interface SidebarPlacedRow<Pin extends SidebarPin = SidebarPin> {
  row: SidebarLayoutRow<Pin>
  hidden: boolean
}

/**
 * The record as this build can read it, or nothing where it cannot: a record that is absent, whose
 * `version` is not this one's, or whose `order` names no row this build carries is today's list. The
 * last case is what makes an empty order today's arrangement rather than a record whose order alone
 * says nothing — and it is read, never written, so a newer build's arrangement survives this one.
 */
function readableRecord(record: SidebarLayoutRecord | undefined, known: Map<string, unknown>) {
  if (!record || record.version !== 1) return undefined
  return record.order.some((id) => known.has(id)) ? record : undefined
}

/**
 * Every known row in the order the account holds it, each saying whether the reader put it away.
 *
 * The order is the record's, with every known row it does not name inserted after the nearest row
 * before it in the catalogue that is already placed — or at the front, where none is — so a feature
 * added to the table takes the place the table gives it and a new pin lands after the pin before it,
 * rather than being filed at the foot of a list the reader did not arrange. An id in the record that
 * no row carries is dropped, so a retired feature leaves no dead place. Nothing here asks a row's lab
 * switch: a row a switch has taken away is still a row this build knows, which is what keeps its id —
 * and the place the reader gave it — through an edit made while the switch was off
 * (`SIDEBAR_FEATURES` reports the gate rather than applying it for this reason).
 */
function placedRows<Pin extends SidebarPin>(
  rows: readonly SidebarLayoutRow<Pin>[],
  record: SidebarLayoutRecord | undefined,
): SidebarPlacedRow<Pin>[] {
  const byId = new Map(rows.map((row) => [row.id, row]))
  const readable = readableRecord(record, byId)
  const named = (readable?.order ?? []).filter((id) => byId.has(id))
  const namedSet = new Set(named)
  const hidden = new Set((readable?.hidden ?? []).filter((id) => byId.has(id)))
  const placed = named.map((id) => byId.get(id)!)
  for (const row of rows) {
    if (namedSet.has(row.id)) continue
    // Walk back through the catalogue to the nearest row already placed and stand after it — rows
    // this pass inserted count, so neighbours keep their order — or at the front where none is.
    let at = 0
    for (let index = rows.indexOf(row) - 1; index >= 0; index -= 1) {
      const found = placed.indexOf(rows[index])
      if (found === -1) continue
      at = found + 1
      break
    }
    placed.splice(at, 0, row)
  }
  return placed.map((row): SidebarPlacedRow<Pin> => ({ row, hidden: hidden.has(row.id) }))
}

/**
 * The rows the resting sidebar draws: every known row the reader has not put away, in the account's
 * order.
 *
 * Hiding the Canvas feature hides its pins here and here alone — a row pointing at a screen the
 * reader has just put away is a dead end at rest. The mode draws them anyway (below), because the
 * pin is the host's own record and only Unpin may end it: hiding Canvas must never take away the
 * one control that lets a pin go.
 */
export function restingSidebarRows<Pin extends SidebarPin>(
  rows: readonly SidebarLayoutRow<Pin>[],
  record: SidebarLayoutRecord | undefined,
): SidebarLayoutRow<Pin>[] {
  const placed = placedRows(rows, record)
  const canvasHidden = placed.some(({ row, hidden }) => row.id === "canvas" && hidden)
  return placed
    .filter(({ row, hidden }) => !hidden && !(canvasHidden && row.kind === "pin"))
    .map(({ row }) => row)
}

/**
 * The rows the mode draws: every known row in its place, each saying whether the reader put it away —
 * a hidden row stays listed here, muted, one press from coming back.
 */
export function sidebarModeRows<Pin extends SidebarPin>(
  rows: readonly SidebarLayoutRow<Pin>[],
  record: SidebarLayoutRecord | undefined,
): SidebarPlacedRow<Pin>[] {
  return placedRows(rows, record)
}

/**
 * The record a hide or a show writes: every known row in the place it stands, and the one row put
 * away or let back.
 *
 * It carries the whole order, so a record this build writes never depends on `hidden` alone, and it
 * names only the ids a row carries — a retired feature's entry goes with the first edit made after
 * it retired. A new record every time: `DEFAULT_SIDEBAR_LAYOUT` is the default settings row's own
 * object, so nothing here edits a record in place.
 */
export function withHidden<Pin extends SidebarPin>(
  rows: readonly SidebarLayoutRow<Pin>[],
  record: SidebarLayoutRecord | undefined,
  id: string,
  hidden: boolean,
): SidebarLayoutRecord {
  const placed = placedRows(rows, record)
  const order = placed.map(({ row }) => row.id)
  const hiddenIds = new Set(placed.filter((row) => row.hidden).map(({ row }) => row.id))
  if (hidden) hiddenIds.add(id)
  else hiddenIds.delete(id)
  return { version: 1, order, hidden: order.filter((rowId) => hiddenIds.has(rowId)) }
}

/** Which way a row moves: one place up the list, or one place down it. */
export type SidebarMove = -1 | 1

/**
 * The record a move writes: the row named, one place up (`-1`) or down (`1`). Read it as "move this
 * row this way, in this record, over these rows".
 *
 * The answer is a complete record — every known row once, in the order this move made, so a move also
 * heals a record another build left, and an id no row carries is gone with it. `hidden` is kept as it
 * stood: a row a reader cannot see still has its place, and moving a visible row past it is a move of
 * the whole list, not of the rows on screen. A move past either end writes the arrangement it found,
 * unchanged, and a first move over a record nobody wrote starts from today's order, since the order a
 * move begins with is the one the sidebar draws. A new record every time: nothing here edits one in
 * place.
 */
export function move<Pin extends SidebarPin>(
  id: string,
  direction: SidebarMove,
  record: SidebarLayoutRecord | undefined,
  rows: readonly SidebarLayoutRow<Pin>[],
): SidebarLayoutRecord {
  const placed = placedRows(rows, record)
  const order = placed.map(({ row }) => row.id)
  const from = order.indexOf(id)
  const to = from + direction
  if (from !== -1 && to >= 0 && to < order.length) {
    const [moved] = order.splice(from, 1)
    order.splice(to, 0, moved)
  }
  return {
    version: 1,
    order,
    hidden: placed.filter((row) => row.hidden).map(({ row }) => row.id),
  }
}

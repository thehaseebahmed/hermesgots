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

export const DEFAULT_SIDEBAR_LAYOUT: SidebarLayoutRecord = { version: 1, hidden: [], order: [] }

/**
 * The shape every layout record has, whatever build wrote it: the number that names the shape, and
 * the two lists the record is made of.
 */
export type SidebarLayoutShape = {
  version: number
  order: readonly string[]
  hidden: readonly string[]
}

/**
 * Whether a value is a layout record at all — a shape number and its two lists of ids — rather than
 * what this build can read: which number it reads is `readableRecord`'s to ask, and what the ids mean
 * is `placedRows`'s, since a row this build no longer carries is dropped rather than refused. So this
 * is the one shape test the rule below and the account's write both read: a value with no `order`, or
 * an `order` that is no list of ids, is no record to either of them.
 */
export function isSidebarLayoutRecord(value: unknown): value is SidebarLayoutShape {
  if (typeof value !== "object" || value === null) return false
  const { version, order, hidden } = value as Partial<SidebarLayoutShape>
  return typeof version === "number" && isIdList(order) && isIdList(hidden)
}

/** A list of row ids, as every version of the record writes one. */
function isIdList(list: unknown): list is string[] {
  return Array.isArray(list) && list.every((id) => typeof id === "string")
}

/**
 * What a row needs of a pinned canvas: the id it is filed under, the title it is drawn with and the
 * mark it draws — a canvas's own picture, or the frame it falls back to, so a pin without one is still
 * a pin a row can draw.
 */
export interface SidebarPin {
  id: string
  title: string
  mark?: string
}

export type SidebarLayoutRow<Pin extends SidebarPin = SidebarPin> =
  SidebarFeatureRow | SidebarPinRow<Pin>

type SidebarFeatureRow = (typeof SIDEBAR_FEATURES)[number] & { kind: "feature" }

/** A pin's row: the one row that lets its canvas go. */
export interface SidebarPinRow<Pin extends SidebarPin> {
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

export interface SidebarPlacedRow<Pin extends SidebarPin = SidebarPin> {
  row: SidebarLayoutRow<Pin>
  hidden: boolean
}

/**
 * The record as this build can read it, or nothing where it cannot: a record that is absent, that is
 * no record at all (`isSidebarLayoutRecord`), whose `version` is not the one this build reads, or
 * whose `order` names no row this build carries is today's list. The last case is what makes an empty
 * order today's arrangement rather than a record whose order alone says nothing — and it is read,
 * never written, so a newer build's arrangement survives this one. Nothing here throws: the sidebar is
 * mounted on every route, and a value the account kept is no reason for the app to draw no nav.
 */
function readableRecord(record: unknown, known: Map<string, unknown>): SidebarLayoutRecord | undefined {
  // The number is this build's to read, and the shape test has said the lists are its two — so what is
  // left to ask is whether the record is one this build knows and whether it names a row it draws.
  if (!isSidebarLayoutRecord(record) || record.version !== 1) return undefined
  return record.order.some((id) => known.has(id)) ? (record as SidebarLayoutRecord) : undefined
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
  // One row, one place: a record whose order names an id twice — a write another build made, a hand
  // edit — draws that row where it first stands and nowhere again, so the list holds one row and one
  // control for it, and the next write names it once.
  const named = [...new Set((readable?.order ?? []).filter((id) => byId.has(id)))]
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
  return restingOf(placedRows(rows, record))
}

function restingOf<Pin extends SidebarPin>(
  placed: readonly SidebarPlacedRow<Pin>[],
): SidebarLayoutRow<Pin>[] {
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
 * Whether the record this build reads is today's arrangement already: no row put away, and every row
 * in the place the catalogue gives it. A record that is absent, empty, or one this build cannot read
 * is today's list too (see `readableRecord`), so Reset has nothing to do for any of them — which is
 * what lets the mode hold its Reset control rather than ask a question with no answer in it.
 */
export function isDefaultLayout<Pin extends SidebarPin>(
  rows: readonly SidebarLayoutRow<Pin>[],
  record: SidebarLayoutRecord | undefined,
): boolean {
  return isDefaultOf(placedRows(rows, record), rows)
}

function isDefaultOf<Pin extends SidebarPin>(
  placed: readonly SidebarPlacedRow<Pin>[],
  rows: readonly SidebarLayoutRow<Pin>[],
): boolean {
  return placed.every(({ row, hidden }, index) => !hidden && row.id === rows[index]?.id)
}

export interface SidebarPlacement<Pin extends SidebarPin = SidebarPin> {
  /** The rows the resting sidebar draws — every known row the reader has not put away, in order. */
  resting: SidebarLayoutRow<Pin>[]
  /** The mode's rows: every known row in its place, each saying whether the reader put it away. */
  mode: SidebarPlacedRow<Pin>[]
  /** Whether the record this build reads is today's arrangement already, so Reset has nothing to do. */
  atDefault: boolean
}

/**
 * Everything the sidebar reads off the account's record, placed once.
 *
 * The three answers are one placement read three ways, and the sidebar asks for all of them on every
 * render, so they are answered together rather than each resolving the list for itself. The gate is
 * the caller's: this says where every known row stands, drawn or not.
 */
export function sidebarPlacement<Pin extends SidebarPin>(
  rows: readonly SidebarLayoutRow<Pin>[],
  record: SidebarLayoutRecord | undefined,
): SidebarPlacement<Pin> {
  const placed = placedRows(rows, record)
  return {
    resting: restingOf(placed),
    mode: placed,
    atDefault: isDefaultOf(placed, rows),
  }
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
 * The record a drop writes: the row named, standing at `index` of the list when the write is done.
 * Read it as "put this row in this place, in this record, over these rows".
 *
 * The one placement both ways of reordering go through, so a drag and a button cannot write two
 * shapes of record: `move` asks it for the place its direction reaches. The answer is a complete
 * record — every known row once, in the order this placement made, so a drop also heals a record
 * another build left, and an id no row carries is gone with it. `hidden` is kept as it stood: a row
 * a reader cannot see still has its place, and carrying a row past it is a move of the whole list,
 * not of the rows on screen. A place past either end is that end, an id no row carries has no place
 * to leave or take, and the first placement over a record nobody wrote starts from today's order.
 * A new record every time: nothing here edits one in place.
 */
export function moveTo<Pin extends SidebarPin>(
  id: string,
  index: number,
  record: SidebarLayoutRecord | undefined,
  rows: readonly SidebarLayoutRow<Pin>[],
): SidebarLayoutRecord {
  return placedOver(placedRows(rows, record), id, index)
}

function placedOver<Pin extends SidebarPin>(
  placed: readonly SidebarPlacedRow<Pin>[],
  id: string,
  index: number,
): SidebarLayoutRecord {
  const order = placed.map(({ row }) => row.id)
  const from = order.indexOf(id)
  if (from !== -1) {
    const [moved] = order.splice(from, 1)
    // The list is one shorter now, so its last place is its length: a drop below the last row lands
    // there rather than one past it.
    order.splice(Math.max(0, Math.min(index, order.length)), 0, moved)
  }
  return {
    version: 1,
    order,
    hidden: placed.filter((one) => one.hidden).map(({ row }) => row.id),
  }
}

/**
 * The record a move writes: the row named, one place up (`-1`) or down (`1`) among the rows the mode
 * draws — the place a control at either end of a row asks for, expressed over the same placement the
 * drop writes through, so both writes normalise once and the list is placed once for the press rather
 * than twice.
 *
 * `drawn` is the ids of the rows the mode draws, in the order it draws them, and it is the list a
 * press moves among: a row a lab switch has taken away is no place the reader can see, so a press
 * moves past it rather than swapping with it — a swap would leave the drawn list exactly as it was
 * while the live region said the row had moved. The row it reaches is the next row the reader can
 * see, and the place it takes is that row's own (`moveTo`'s), which is the place a drag writes. A
 * press at either end of the drawn list writes nothing new; every known id where a caller names none.
 */
export function move<Pin extends SidebarPin>(
  id: string,
  direction: SidebarMove,
  record: SidebarLayoutRecord | undefined,
  rows: readonly SidebarLayoutRow<Pin>[],
  drawn?: readonly string[],
): SidebarLayoutRecord {
  const placed = placedRows(rows, record)
  const order = placed.map(({ row }) => row.id)
  const shown = drawn ?? order
  const at = shown.indexOf(id)
  // The row the press reaches: the next one the reader can see. Nothing where the drawn list ends
  // there, and the row's own place is where it then stands — placed once, and named once.
  const neighbour = at === -1 ? undefined : shown[at + direction]
  const to = neighbour === undefined ? order.indexOf(id) : order.indexOf(neighbour)
  return placedOver(placed, id, to)
}

/**
 * The General page: the settings on this bot's own Hermes, as the Dashboard's Config > General tab
 * holds them. The list is the host's, not this file's — the keys, their kinds and their choices all
 * come from the host's schema in one read, so a key Hermes adds later appears without an app release
 * and a row is never one the host would refuse. What lives here is what a row is read with: the words
 * a key's name becomes, the caption its section gets, and how a value or a pick is drawn.
 */

import {
  effective,
  mappingOf,
  parseNumber,
  rowValue,
  scalarsOf,
  type SettingBlock,
  type SettingValue,
} from "./settings-values.ts"

/** The feature a host advertises when it carries the Dashboard's General tab. */
export const GENERAL_PAGE = "general_page"

export const DELEGATION_PAGE = "delegation_page"

/** One of the host's keys, as the read offers it. */
export interface GeneralField {
  /** The dotted path, exactly as Hermes spells it: `session.terminal_continue`, `timezone`. */
  key: string
  kind: GeneralControl
  /** The key's own first segment: the card it is filed under, and `""` at the top level. */
  section: string
  /** A closed set's choices, for a pick. */
  options?: string[]
  /** Whether a pick's list is long enough to need a search field over it. */
  searchable?: boolean
  /** Whether the host only opens this key when its process starts. */
  restart?: boolean
  /** The host's own sentence about what this key's value means, where it reads wrong without one. */
  note?: string
}

/** What a row is: a switch, a closed set, a number, a list of values, or something typed. */
export type GeneralControl = "switch" | "pick" | "number" | "list" | "text"

/** The schema's own names for those, as the host spells them. */
const CONTROL: Record<string, GeneralControl> = {
  boolean: "switch",
  select: "pick",
  number: "number",
  list: "list",
  string: "text",
}

/** What one of these keys holds: a scalar, or — for a list Hermes declared scalars in — its entries. */
export type GeneralValue = SettingValue | string[]

/** The page's one read, as the host answers it. */
export interface GeneralSettings extends SettingBlock<GeneralValue> {
  fields: GeneralField[]
}

/**
 * The host's answer as the page draws it, forgivingly: a field whose kind the app can't draw is left
 * out rather than drawn as a row nothing could save, and a read with no fields is no block at all —
 * which is what a host from before this page answers.
 */
export function readGeneral(raw: unknown): GeneralSettings | undefined {
  const block = mappingOf(raw)
  if (!block) return undefined
  const fields = Array.isArray(block.fields) ? block.fields.flatMap(fieldOf) : []
  if (!fields.length) return undefined
  return { values: scalarsOf(block.values), defaults: scalarsOf(block.defaults), fields }
}

function fieldOf(raw: unknown): GeneralField[] {
  const row = mappingOf(raw)
  if (!row) return []
  const kind = CONTROL[String(row.kind)]
  if (typeof row.key !== "string" || !row.key || !kind) return []
  const field: GeneralField = {
    key: row.key,
    kind,
    section: typeof row.section === "string" ? row.section : "",
  }
  if (Array.isArray(row.options))
    field.options = row.options.filter((one): one is string => typeof one === "string")
  // A pick with no choices offers nothing to pick: its row is drawn as the value it holds.
  if (kind === "pick" && !field.options?.length) return []
  if (row.searchable === true) field.searchable = true
  if (row.restart === true) field.restart = true
  if (typeof row.note === "string" && row.note) field.note = row.note
  return [field]
}

/** One card: a caption — empty for the page's own settings — and the rows under it, in host order. */
export interface GeneralGroup {
  section: string
  /** The caption's words, or `""` where the card carries none. */
  title: string
  rows: GeneralField[]
}

/**
 * The page's cards, in the order the host first names each section: a section is one card wherever its
 * keys sit, since a host is free to interleave `timezone` between two `updates.*` keys and the reader
 * is reading sections, not positions. A key's section is its own first segment, which is the rule the
 * Dashboard's own renderer groups by — nothing here invents a filing the host doesn't have.
 */
export function generalGroups(fields: readonly GeneralField[]): GeneralGroup[] {
  const groups: GeneralGroup[] = []
  const seen = new Map<string, GeneralGroup>()
  for (const field of fields) {
    let group = seen.get(field.section)
    if (!group) {
      group = { section: field.section, title: sectionTitle(field.section), rows: [] }
      seen.set(field.section, group)
      groups.push(group)
    }
    group.rows.push(field)
  }
  return groups
}

/** A section's caption: its own name with the underscores opened out. */
export function sectionTitle(section: string): string {
  if (!section) return ""
  const words = section.replace(/_/g, " ")
  return words[0].toUpperCase() + words.slice(1)
}

/** The initialisms a key's name keeps whole, so a row doesn't read "Mcp discovery timeout". */
const UPPER = new Set(["mcp", "url", "api", "id", "cua", "stt", "tts", "llm", "vad", "json"])

/**
 * A key's row title: its last segment, with the underscores opened out and the initialisms kept
 * whole. The host's own descriptions are generated titles ("Updates → Pre Update Backup"), so the
 * name the key already has is what a row reads by.
 */
export function fieldLabel(key: string): string {
  const words = (key.split(".").pop() ?? key).split("_").filter(Boolean)
  if (!words.length) return key
  return words
    .map((word, index) => {
      const lower = word.toLowerCase()
      if (UPPER.has(lower)) return lower.toUpperCase()
      return index === 0 ? lower[0].toUpperCase() + lower.slice(1) : lower
    })
    .join(" ")
}

/**
 * What a row shows: a pick's choice in its own words, a list's entries, or the value itself. A
 * switch draws its state instead, and an empty answer leaves the row saying Not set.
 */
export function generalRowValue(block: GeneralSettings, field: GeneralField): string {
  const value = effective(block, field.key)
  if (field.kind === "list") return Array.isArray(value) ? value.join(", ") : ""
  if (field.kind === "pick") return optionLabel(value)
  return rowValue(block, field.key)
}

/** A pick's choice as a row reads it: `quick` is Quick, and an empty choice means the host's own. */
export function optionLabel(value: GeneralValue): string {
  if (value === null || typeof value !== "string" || !value) return ""
  return value
    .split(/[_\s]+/)
    .filter(Boolean)
    .map((word, index) => (index === 0 ? word[0].toUpperCase() + word.slice(1) : word))
    .join(" ")
}

/**
 * The value a form starts on, for the field it edits: a pick's own choice, a list's entries joined
 * for the one field it is typed into, or the value as text.
 */
export function draftOf(block: GeneralSettings, field: GeneralField): string {
  const value = effective(block, field.key)
  if (field.kind === "list") return Array.isArray(value) ? value.join(", ") : ""
  return value === null ? "" : String(value)
}

/**
 * What a typed draft writes: a number as a number, a list split on its commas, nothing for a field
 * emptied — which is the key leaving the file and the host's default taking over.
 */
export function draftValue(
  field: GeneralField,
  draft: string,
): { ok: true; value: SettingValue | string[] } | { ok: false } {
  if (field.kind === "list") {
    const entries = draft
      .split(",")
      .map((one) => one.trim())
      .filter(Boolean)
    return { ok: true, value: entries.length ? entries : null }
  }
  if (field.kind === "number") return parseNumber(draft)
  const text = draft.trim()
  return { ok: true, value: text || null }
}

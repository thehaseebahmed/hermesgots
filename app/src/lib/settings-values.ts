/**
 * What a setting is holding, for the pages that draw a host's own keys: the value the file holds or
 * the host's default behind it, and the few readings a row makes of either. Import-free, so the unit
 * tier pins every rule without a host (ADR 0063's shape, one table for the pages that share it).
 */

/**
 * One of a host's two maps as a mapping, or nothing where the answer isn't one — the guard both
 * readers of a host's block make before they read a key out of it.
 */
/**
 * The scalar leaves of a values object, by dotted key: what a row can show and write back. A list of
 * scalars comes through as its entries, and an object or a list of objects is another page's shape and
 * is left out rather than drawn as a value nothing can save.
 */
export function scalarsOf(raw: unknown): Record<string, SettingValue | string[]> {
  const out: Record<string, SettingValue | string[]> = {}
  const map = mappingOf(raw)
  if (!map) return out
  for (const [key, value] of Object.entries(map)) {
    if (value === null || ["string", "number", "boolean"].includes(typeof value)) {
      out[key] = value as SettingValue
      continue
    }
    if (Array.isArray(value) && value.every((one) => ["string", "number"].includes(typeof one)))
      out[key] = value.map(String)
  }
  return out
}

export function mappingOf(raw: unknown): Record<string, unknown> | undefined {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined
  return raw as Record<string, unknown>
}

/** A setting's value as the host answers it: a scalar, or nothing where it holds none. */
export type SettingValue = string | number | boolean | null

/**
 * The two maps a host answers with: only the keys its file holds, and its default for each. The value
 * type is the page's own — a speech setting is a scalar, and a list Hermes declared scalars in holds
 * its entries — so one reading serves both.
 */
export interface SettingBlock<V = SettingValue> {
  values: Record<string, V>
  defaults: Record<string, V>
}

/** Whether the file really holds this key, rather than the host falling back to its default. */
export function explicitly<V>(block: SettingBlock<V>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(block.values, key)
}

/** What will happen: the value written, else the host's own default for the key. */
export function effective<V>(block: SettingBlock<V>, key: string): V | null {
  if (explicitly(block, key)) return block.values[key] ?? null
  const fallback = block.defaults[key]
  return fallback === undefined ? null : fallback
}

/** A row's value as a user reads it: empty where nothing is held, so the row says Not set. */
export function rowValue<V>(block: SettingBlock<V>, key: string): string {
  const value = effective(block, key)
  if (value === null || value === "") return ""
  if (typeof value === "boolean") return value ? "On" : "Off"
  return String(value)
}

/** A switch's state: on unless the host says off, as Hermes reads its own truthiness. */
export function rowOn<V>(block: SettingBlock<V>, key: string): boolean {
  const value = effective(block, key)
  if (typeof value === "boolean") return value
  if (typeof value === "number") return value !== 0
  if (typeof value === "string")
    return !["", "false", "no", "off", "0"].includes(value.trim().toLowerCase())
  return false
}

/** A typed number, or `null` for a field left blank — which means the host's own default. */
export type ParsedNumber = { ok: true; value: number | null } | { ok: false }

/**
 * `null` is a field cleared back to the host's default; anything that isn't a number is refused
 * before it is written, since Hermes declares no bound on any of these and these pages add none.
 */
export function parseNumber(text: string): ParsedNumber {
  const trimmed = text.trim()
  if (!trimmed) return { ok: true, value: null }
  if (!/^-?(\d+(\.\d+)?|\.\d+)$/.test(trimmed)) return { ok: false }
  const value = Number(trimmed)
  return Number.isFinite(value) ? { ok: true, value } : { ok: false }
}

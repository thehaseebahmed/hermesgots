/**
 * What the Skills tab draws from the one skills list: how a row says it is doing, and the sections
 * and category groups it sits in. Kept import-free but for types and the one rule it shares with
 * `skills-cache.ts` (what "doesn't load" means), so `scripts/test-skills-tab.mjs` can drive it
 * without a browser (as `mcp-server.ts` is for the MCP rows).
 */
import type { Skill, SkillView } from "@/lib/hermes"
import { byName } from "./compare.ts"
import { loadFailure } from "./skills-cache.ts"

export interface SkillHealth {
  text: string
  failed: boolean
}

export interface RowControls {
  onToggle: (name: string, enabled: boolean) => void
  saving: string | null
}

/**
 * The controls a skill's switch draws, or undefined where it has none: a list with nothing to
 * write to offers no switch, and neither does a skill the host says it can't switch.
 */
export function switchableControls(
  controls: RowControls | undefined,
  skill: Skill,
): RowControls | undefined {
  return skill.switchable === false ? undefined : controls
}

export function skillHealth(skill: Skill): SkillHealth {
  const reason = loadFailure(skill)
  if (reason) return { text: `Doesn't load: ${reason}`, failed: true }
  if (skill.enabled === false) return { text: "Off", failed: false }
  return { text: "Ready", failed: false }
}

export type SkillSectionId = "yours" | "plugins"

export interface SkillGroup {
  category: string | null
  skills: Skill[]
}

export interface SkillSection {
  id: SkillSectionId
  /** What draws over the section, or null where the tab opens straight at its category titles. */
  heading: string | null
  groups: SkillGroup[]
}

const SECTIONS: { id: SkillSectionId; title: string; plugins: boolean }[] = [
  { id: "yours", title: "Your skills", plugins: false },
  { id: "plugins", title: "From plugins", plugins: true },
]

function categoryOf(skill: Skill): string | null {
  const category = skill.category?.trim()
  return category ? category : null
}

function groupsOf(skills: Skill[]): SkillGroup[] {
  const held = new Map<string | null, Skill[]>()
  for (const skill of skills) {
    const category = categoryOf(skill)
    const group = held.get(category)
    if (group) group.push(skill)
    else held.set(category, [skill])
  }
  return [...held]
    .sort(([left], [right]) => {
      if (left === null) return 1
      return right === null ? -1 : byName(left, right)
    })
    .map(([category, rows]) => ({
      category,
      skills: rows.sort((left, right) => byName(left.name, right.name)),
    }))
}

export function skillSections(skills: Skill[]): SkillSection[] {
  const built = SECTIONS.map(({ id, title, plugins }) => ({
    id,
    title,
    groups: groupsOf(skills.filter((skill) => (skill.origin === "plugin") === plugins)),
  }))
  // Both kinds on the bot is the only time the split is worth a word: a tab holding one kind
  // opens straight at its category titles rather than a heading over a single group list.
  const bothKinds = built.every((section) => section.groups.length > 0)
  return built.map(({ id, title, groups }) => ({
    id,
    heading: bothKinds ? title : null,
    groups,
  }))
}

/**
 * What an origin means where both facets of it are read: the sheet's one word for where a skill came
 * from, and whether a skill of that origin can be removed. A row that names no origin (an older
 * plugin) reads as no word and not removable, so the sheet leaves the line out rather than guessing.
 */
const ORIGINS: Record<string, { label: string; removable: boolean }> = {
  builtin: { label: "Built in", removable: false },
  hub: { label: "Installed from the Hub", removable: true },
  yours: { label: "Yours", removable: true },
  plugin: { label: "From a plugin", removable: false },
}

/** The origin's two facets, or undefined where the row names no origin the table knows. */
function originFacts(skill: Skill) {
  return skill.origin ? ORIGINS[skill.origin] : undefined
}

/**
 * Where a skill came from, in the sheet's one line, or null where the row doesn't say (ADR 0045).
 */
export function skillOrigin(skill: Skill): string | null {
  return originFacts(skill)?.label ?? null
}

export function canRemove(skill: Skill): boolean {
  return originFacts(skill)?.removable ?? false
}

export interface SkillSetupLine {
  key: "readiness" | "setup"
  label: "Readiness" | "Setup"
  text: string
}

/**
 * The lines the sheet draws about a skill's own state, in the order it has them: the host's readiness
 * status, then its setup sentence. Both are kept, because a host that says it needs setup also says
 * how ready it is, and the two answer different questions. A host that says neither draws nothing.
 */
export function skillSetup(view: SkillView): SkillSetupLine[] {
  const lines: SkillSetupLine[] = []
  const status = view.readiness_status?.trim()
  if (status) lines.push({ key: "readiness", label: "Readiness", text: status })
  const setup =
    view.setup_note?.trim() || view.setup_help?.trim() || view.gateway_setup_hint?.trim()
  if (setup) lines.push({ key: "setup", label: "Setup", text: setup })
  return lines
}

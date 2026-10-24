/**
 * What the Skills tab draws from the one skills list: how a row says it is doing, and the sections
 * and category groups it sits in. Kept import-free but for types and the one rule it shares with
 * `skills-cache.ts` (what "doesn't load" means), so `scripts/test-skills-tab.mjs` can drive it
 * without a browser (as `mcp-server.ts` is for the MCP rows).
 */
import type { Skill, SkillView } from "@/lib/hermes"
import { loadFailure } from "./skills-cache.ts"

export interface SkillHealth {
  text: string
  failed: boolean
}

export interface RowControls {
  onToggle: (name: string, enabled: boolean) => void
  saving: string | null
}

export function offersSwitch(controls: RowControls | undefined, skill: Skill): boolean {
  return controls !== undefined && skill.switchable !== false
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
      return right === null ? -1 : collated(left, right)
    })
    .map(([category, rows]) => ({
      category,
      skills: rows.sort((left, right) => collated(left.name, right.name)),
    }))
}

export function collated(left: string, right: string): number {
  return left.localeCompare(right, "en", { sensitivity: "base" })
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
 * Where a skill came from, in the sheet's one line, or null where the row doesn't say (ADR 0045).
 *
 * An older plugin answers no `origin` at all. The tab's sections have to file such a row somewhere,
 * and they file it as the profile's own; a line saying where a skill came from is worth nothing if it
 * is a guess, so the sheet leaves it out rather than repeating that default.
 */
export function skillOrigin(skill: Skill): string | null {
  switch (skill.origin) {
    case "builtin":
      return "Built in"
    case "hub":
      return "Installed from the Hub"
    case "yours":
      return "Yours"
    case "plugin":
      return "From a plugin"
    default:
      return null
  }
}

export function canRemove(skill: Skill): boolean {
  return skill.origin === "hub" || skill.origin === "yours"
}

export interface SkillSetupLine {
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
  if (status) lines.push({ label: "Readiness", text: status })
  const setup =
    view.setup_note?.trim() || view.setup_help?.trim() || view.gateway_setup_hint?.trim()
  if (setup) lines.push({ label: "Setup", text: setup })
  return lines
}

/**
 * What the Skills tab draws from the one skills list: how a row says it is doing, the sections and
 * category groups it sits in, and the pills and the words that narrow it. Kept browserless — its only
 * imports are types and two import-free rules, `skills-cache.ts`'s answer for what "doesn't load"
 * means and `fuzzy.ts`'s matcher — so `scripts/test-skills-tab.mjs` drives it under `node --test` (as
 * `mcp-server.ts` is for the MCP rows).
 */
import type { Skill, SkillView } from "@/lib/hermes"
import { byName } from "./compare.ts"
import { filterByFuzzy } from "./fuzzy.ts"
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

/**
 * The one order categories run in: alphabetically, and the group with no category of its own last. The
 * pills and the groups both read it, so the two cannot name the categories in a different order.
 */
export function compareCategories(left: string | null, right: string | null): number {
  if (left === null) return right === null ? 0 : 1
  return right === null ? -1 : byName(left, right)
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
    .sort(([left], [right]) => compareCategories(left, right))
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

/** What the pill that keeps every skill is called. */
export const ALL_SKILLS = "All"

/**
 * The key All's pill is pressed by. No category can be it: a category that is empty or only
 * whitespace is no category at all (`categoryOf`), so the pill called All and a category that happens
 * to be named `all` are two keys rather than one — and a React key and a press both go by this.
 */
export const ALL_SKILLS_KEY = ""

/** One pill of the tab's row: the key it is pressed and keyed by, and the word it wears. */
export interface SkillPill {
  key: string
  label: string
}

/** The categories the tab's skills name, in the one order categories run in. */
function categoriesOf(skills: Skill[]): string[] {
  const named = new Set(skills.map(categoryOf))
  return [...named]
    .filter((category): category is string => category !== null)
    .sort(compareCategories)
}

/**
 * The pills the tab offers, in the order it draws them: All first, then every category its skills
 * name, alphabetically. One pill per category name however many sections hold a skill of it — the
 * reader picks a category, not a category in a section — and a skill with none is kept by All alone,
 * since a pill exists only for a category the tab holds.
 */
export function skillPills(skills: Skill[]): SkillPill[] {
  return [
    { key: ALL_SKILLS_KEY, label: ALL_SKILLS },
    ...categoriesOf(skills).map((category) => ({ key: category, label: category })),
  ]
}

/**
 * The skills a pill keeps, in the order they were handed in: a filter narrows the list, it never
 * re-orders it, and the tab groups what it kept the way it grouped the whole.
 */
export function pillKeeps(skills: Skill[], key: string): Skill[] {
  return key === ALL_SKILLS_KEY ? skills : skills.filter((skill) => categoryOf(skill) === key)
}

/**
 * What the tab draws, as one rule: the pill narrows the list first, then the words narrow what the
 * pill kept — so the empty sentence can only ever be the search's, and a category's caption can never
 * stand over rows the words dropped. A skill answers to its name and its description, the way the chat
 * list's rows answer to their title and their line.
 */
export function skillsKept(skills: Skill[], key: string, query: string): Skill[] {
  return filterByFuzzy(pillKeeps(skills, key), query, (skill) => [
    skill.name,
    skill.description ?? undefined,
  ])
}

/** What a group with no category of its own is called. */
export const NO_CATEGORY = "No category"

export interface CategoryHeader {
  /** The category's name, or `No category` for the group that has none. */
  title: string
  /** `N of M on` where the category holds more than one skill; a lone skill's own name; null alone. */
  subtitle: string | null
  /** Whether any of the category's skills is on, which is also what a tap on it flips from. */
  checked: boolean
}

/**
 * A category's header row, drawn like a Notification types feature header: the category's name over
 * a line saying how much of it is on, and a switch that stands for all of it. A category reads on
 * while any skill in it is on, so a tap that turns it off leaves nothing on, and one on a category
 * that is all off turns every skill in it on. A one-skill category carries no count — its line is
 * the skill's own name, the way a feature of one category names it.
 */
export function categoryHeader(group: SkillGroup): CategoryHeader {
  const total = group.skills.length
  const on = group.skills.filter((skill) => skill.enabled !== false).length
  return {
    title: group.category ?? NO_CATEGORY,
    subtitle: total > 1 ? `${on} of ${total} on` : (group.skills[0]?.name ?? null),
    checked: on > 0,
  }
}

/**
 * The rows a tap on a category's header writes: the skills whose switch the tap would actually
 * change, so a skill already where the category is going is left alone, and one the Host says it
 * can't switch is never written at all.
 */
export function categoryWrites(group: SkillGroup, enabled: boolean): string[] {
  return group.skills
    .filter((skill) => skill.switchable !== false && (skill.enabled !== false) !== enabled)
    .map((skill) => skill.name)
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

/**
 * What the Skills tab draws from the one skills list: how a row says it is doing, and the sections
 * and category groups it sits in. Kept import-free but for types, so `scripts/test-skills-tab.mjs`
 * can drive it without a browser (as `mcp-server.ts` is for the MCP rows).
 */
import type { Skill, SkillView } from "@/lib/hermes"

/** A row's prose line, and whether it is a failure to read — which is what colours it. */
export interface SkillHealth {
  text: string
  failed: boolean
}

/**
 * How one skill is doing, in the words the tab uses (ADR 0045).
 *
 * The Host's own reason comes first, whatever else the row carries, because a skill that doesn't
 * load is the thing to read — and the only way out of a broken one is taking it away. The switch
 * comes next, since an off skill is off rather than broken. A row that says neither is ready: an
 * older plugin, or a device row cached before those fields, must never make a skill look broken.
 */
export function skillHealth(skill: Skill): SkillHealth {
  const reason = skill.loadError?.trim()
  if (reason) return { text: `Doesn't load: ${reason}`, failed: true }
  if (skill.enabled === false) return { text: "Off", failed: false }
  return { text: "Ready", failed: false }
}

/** The tab's two lists: the profile's own skills, and the ones a Hermes plugin provides. */
export type SkillSectionId = "yours" | "plugins"

/** One category's rows: the category, or `null` for the rows that have none. */
export interface SkillGroup {
  category: string | null
  skills: Skill[]
}

/** One of the tab's two lists: its heading, and its rows grouped by category. */
export interface SkillSection {
  id: SkillSectionId
  /** The heading, exactly as the decision words it. */
  title: string
  /** The groups in the order the tab draws them, or none where the section holds no rows. */
  groups: SkillGroup[]
}

/** The two lists, in the order they are drawn. */
const SECTIONS: { id: SkillSectionId; title: string; plugins: boolean }[] = [
  { id: "yours", title: "Your skills", plugins: false },
  { id: "plugins", title: "From plugins", plugins: true },
]

/** A row's category as the tab groups it: a category with nothing in it is no category at all. */
function categoryOf(skill: Skill): string | null {
  const category = skill.category?.trim()
  return category ? category : null
}

/**
 * One section's rows grouped by category, ordered the way the tab draws them: the categories
 * alphabetically as the reader's own language sorts them, the rows without one last, and the rows
 * of each group by name. Hermes's own sort puts the uncategorised first and does no grouping, so
 * this order is the app's own rule rather than the Host's.
 */
function groupsOf(skills: Skill[]): SkillGroup[] {
  const held = new Map<string | null, Skill[]>()
  for (const skill of skills) {
    const category = categoryOf(skill)
    const group = held.get(category)
    if (group) group.push(skill)
    else held.set(category, [skill])
  }
  return [...held]
    .sort(([left], [right]) =>
      left === null ? 1 : right === null ? -1 : left.localeCompare(right),
    )
    .map(([category, rows]) => ({
      category,
      skills: rows.sort((left, right) => left.name.localeCompare(right.name)),
    }))
}

/**
 * Everything the tab lists, in its two sections and their groups: the profile's own skills — built
 * in, from the Hub and the user's — then the ones a plugin on the Host provides, since those are
 * the two things a row can be. A skill is the profile's own unless it came from a plugin, so a row
 * that doesn't say where it came from (an older plugin) is the profile's.
 *
 * Both sections come back whether or not they hold anything: this rule orders, and the screen is
 * what drops a heading with no rows under it. Rows that are off or don't load are here like any
 * other, because listing them is how their owner finds them again.
 */
export function skillSections(skills: Skill[]): SkillSection[] {
  return SECTIONS.map(({ id, title, plugins }) => ({
    id,
    title,
    groups: groupsOf(skills.filter((skill) => (skill.origin === "plugin") === plugins)),
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

/**
 * Whether the skill's origin has a removal behind it, which is what offers Remove on its sheet
 * (ADR 0044): a Hub skill's own uninstall, and a profile skill's delete. A built-in is Hermes's own
 * and is never removed, a plugin's skill belongs to its package and gets the switch and nothing
 * else, and a row that doesn't say where it came from is not one to promise a removal for.
 */
export function canRemove(skill: Skill): boolean {
  return skill.origin === "hub" || skill.origin === "yours"
}

/** One line of a sheet's readiness and setup: the screen's label, and the Host's own words. */
export interface SkillSetupLine {
  label: "Readiness" | "Setup"
  text: string
}

/**
 * The Host's readiness and setup as the sheet's lines, or none where it said nothing about them.
 *
 * The Host's own sentence comes first and stands alone where it has one — `setup_note` is written to
 * be read, and already names what is missing and appends any help — because a sentence built for the
 * occasion beats a word lifted out of an enum. Only where the Host has no sentence does its status
 * word stand on its own, under a label: the label is the sheet's own, and it does not dress the word
 * up into something the Host never said.
 */
export function skillSetup(view: SkillView): SkillSetupLine[] {
  const sentence = [view.setup_note, view.setup_help, view.gateway_setup_hint]
    .map((line) => line?.trim())
    .find((line): line is string => Boolean(line))
  if (sentence) return [{ label: "Setup", text: sentence }]
  const status = view.readiness_status?.trim()
  return status ? [{ label: "Readiness", text: status }] : []
}

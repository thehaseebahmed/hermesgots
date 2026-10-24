import type { Skill } from "@/lib/hermes"

/** What the composer's menu has to show for a bot: the list this page holds, or a read in flight. */
export type SkillsState = { status: "loading" } | { status: "ok"; skills: Skill[] }

/**
 * What the menu shows, from the list this page holds for the bot (`known` — the host's last answer, or
 * a device row read before it) and whether a read has finished for it, kept import-free so
 * `scripts/test-skills-cache.mjs` can drive it.
 */
export function skillsState({
  key,
  known,
  settled,
}: {
  /** The connection this menu is for; empty for a bot the app reads no plugin route for at all. */
  key: string
  /** The last list this page holds for that connection, if it holds one. */
  known?: Skill[]
  /** The connection whose read has finished, whether it brought a list or not. */
  settled: string | null
}): SkillsState {
  // What the page holds answers first, so a read that fails leaves it standing; a read that lands
  // writes the new list before it settles, so this shows the fresh one.
  if (known) return { status: "ok", skills: known }
  if (!key) return { status: "ok", skills: [] }
  // The read is over and brought nothing: the commands alone, never a panel left holding a spinner.
  return settled === key ? { status: "ok", skills: [] } : { status: "loading" }
}

export function loadFailure(skill: Skill): string | null {
  return skill.loadError?.trim() || null
}

/**
 * The skills the bot can run right now: what the composer's `/` menu and every picker offer.
 *
 * One rule over the one list, so a skill switched off or broken leaves all of them at once — the
 * rule ADR 0044 states. A row that says neither (`enabled`/`loadError` absent: an older plugin, or
 * a device row cached before it) is runnable, because an unanswered host must never take a skill
 * away. This is not `useSkills`' filter: the Skills tab reads the whole list from the same hook.
 */
export function runnableSkills(skills: Skill[]): Skill[] {
  return skills.filter((skill) => skill.enabled !== false && loadFailure(skill) === null)
}

import { SparklesIcon } from "lucide-react"

import { Group, rowClass, RowText } from "@/components/settings-chrome"
import { Badge } from "@/components/ui/badge"
import type { Profile } from "@/lib/db"
import { usePluginFeature } from "@/lib/features"
import type { Skill } from "@/lib/hermes"
import { useSkills } from "@/lib/skills"
import { skillHealth, skillSections, type SkillSection } from "@/lib/skills-tab"
import { cn } from "@/lib/utils"

/**
 * A bot's skills, as a tab of its Settings: everything the profile holds — the skills seeded with
 * Hermes, the ones installed from a Hub, the ones written on it and the ones a plugin provides —
 * in two sections, *Your skills* then *From plugins*, each grouped by category with the rows that
 * have none last (ADR 0045).
 *
 * Every row says how it is doing in a line under its description, `Ready`, `Off` or `Doesn't load`
 * with the Host's own reason, and the rows that are off or broken are listed like any other: a
 * skill that doesn't load is one its owner can only fix by taking it away. A heading with nothing
 * under it is dropped, so a bot with no plugin skills shows the one section.
 *
 * The list is the composer's `/` menu's list, unfiltered — that menu keeps what the bot can run,
 * and this screen is the one that has to show what it can't. Nothing here changes a skill yet: the
 * switch and the skill sheet are their own later work, so a row is its name, its category, its
 * description and its health, and nothing to press.
 */
export function SkillsTab({ profile }: { profile: Profile }) {
  // The tab is drawn only where the Host advertises listing skills, so a Host without it is never
  // asked for a list it can't give.
  const answer = usePluginFeature(profile, "skills")
  const state = useSkills(profile, answer === "yes")
  if (answer !== "yes") return null
  // The tab arriving, rather than a bot without skills: a first-ever open waits for the read
  // instead of drawing an empty frame the list then fills.
  if (state.status === "loading") return null
  return (
    <div className="flex flex-col gap-4" data-skills-tab>
      {skillSections(state.skills).map((section) => (
        <Section key={section.id} section={section} />
      ))}
    </div>
  )
}

/**
 * One of the tab's two lists: its heading, then one labelled group per category. A section with no
 * rows at all is left out — a heading over nothing says there are none — and so is a category the
 * rule handed over empty.
 */
function Section({ section }: { section: SkillSection }) {
  const groups = section.groups.filter((group) => group.skills.length > 0)
  if (groups.length === 0) return null
  return (
    <section className="flex flex-col gap-2" data-skill-section={section.id}>
      <h2 className="px-2 text-sm font-medium text-muted-foreground">{section.title}</h2>
      <div className="flex flex-col gap-3">
        {groups.map((group) => (
          <div
            key={group.category ?? ""}
            className="flex flex-col gap-1"
            data-skill-group={group.category ?? ""}
          >
            <h3 className="px-2 text-xs font-medium text-muted-foreground">
              {group.category ?? "No category"}
            </h3>
            <Group>
              {group.skills.map((skill) => (
                <SkillItem key={skill.name} skill={skill} />
              ))}
            </Group>
          </div>
        ))}
      </div>
    </section>
  )
}

/**
 * One skill: its name, the category it sits in, what it is for, and how it is doing underneath —
 * the same name, badge and description a skill wears in the composer's menu, with the health line
 * an MCP server's row has. The line is the Host's own text where it failed, so it reads as the
 * failure it is.
 */
function SkillItem({ skill }: { skill: Skill }) {
  const health = skillHealth(skill)
  const title = (
    <span className="flex min-w-0 items-center gap-2">
      <span className="truncate">{skill.name}</span>
      {skill.category && (
        <Badge variant="secondary" className="max-w-28">
          <span className="truncate">{skill.category}</span>
        </Badge>
      )}
    </span>
  )
  return (
    <div className={rowClass} data-skill={skill.name}>
      <SparklesIcon className="size-5 shrink-0 text-muted-foreground" />
      <div className="flex min-w-0 flex-1 flex-col">
        <RowText title={title} subtitle={skill.description} />
        <span
          className={cn("text-sm", health.failed ? "text-destructive" : "text-muted-foreground")}
        >
          {health.text}
        </span>
      </div>
    </div>
  )
}

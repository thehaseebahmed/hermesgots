import { SparklesIcon } from "lucide-react"
import { useState } from "react"
import { toast } from "sonner"

import { SkillDetailSheet } from "@/components/skill-detail-sheet"
import { Group, rowClass, RowText } from "@/components/settings-chrome"
import { Badge } from "@/components/ui/badge"
import { Switch } from "@/components/ui/switch"
import type { Profile } from "@/lib/db"
import type { Skill } from "@/lib/hermes"
import { useSkillFeatureAnswers, useSkills } from "@/lib/skills"
import { skillHealth, skillSections, type SkillSection } from "@/lib/skills-tab"
import { cn } from "@/lib/utils"

/**
 * What a row needs to carry its switch: the write to make, and which row's write is in flight.
 * Absent where the Host advertises no switch, so a read-only tab is a tab with no controls.
 */
type RowControls = {
  onToggle: (name: string, enabled: boolean) => void
  saving: string | null
}

/**
 * What the tab is showing over the list: exactly one sheet, or none. A skill's sheet is the only one
 * there is so far, and the removal adds itself to this state when it lands.
 */
type Sheet = { kind: "skill"; name: string }

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
 * and this screen is the one that has to show what it can't. A row's switch is one thing to press
 * here: one switch means the bot as a whole (the profile's global disabled list, ADR 0044), and the
 * Host's row replaces the one every consumer reads, so a skill switched off leaves the menu and the
 * pickers at once. A row's title is the other: it opens the skill's own sheet, where a Host offers
 * one, and reads that one skill when it opens.
 */
export function SkillsTab({ profile }: { profile: Profile }) {
  // The tab is drawn only where the Host advertises listing skills, and its switches only where it
  // advertises writing one: a Host that can read a profile's skills without being able to write one
  // offers a list and no controls, rather than a control that could only come back refused.
  const answers = useSkillFeatureAnswers(profile)
  const answer = answers.list
  const state = useSkills(profile, answer === "yes")
  // The row whose write is in flight, by name: only that switch waits, and the rest stay pressable.
  const [saving, setSaving] = useState<string | null>(null)
  const [sheet, setSheet] = useState<Sheet | null>(null)
  if (answer !== "yes") return null
  // The tab arriving, rather than a bot without skills: a first-ever open waits for the read
  // instead of drawing an empty frame the list then fills.
  if (state.status === "loading") return null

  const toggle = async (name: string, enabled: boolean) => {
    setSaving(name)
    try {
      await state.setEnabled(name, enabled)
    } catch (error) {
      // The Host's own sentence, with the row unchanged: a refusal leaves nothing half-changed.
      toast.error(error instanceof Error ? error.message : "Couldn't save that.")
    } finally {
      setSaving(null)
    }
  }

  const controls = answers.write === "yes" ? { onToggle: toggle, saving } : undefined
  // A sheet only exists where the Host offers a lookup for it, so a row whose title could open
  // nothing keeps its name plain (an older plugin).
  const open =
    answers.view === "yes" ? (name: string) => setSheet({ kind: "skill", name }) : undefined
  return (
    <div className="flex flex-col gap-4" data-skills-tab>
      {skillSections(state.skills).map((section) => (
        <Section key={section.id} section={section} controls={controls} onOpen={open} />
      ))}
      {sheet?.kind === "skill" && (
        <SkillDetailSheet config={profile} name={sheet.name} onClose={() => setSheet(null)} />
      )}
    </div>
  )
}

/**
 * One of the tab's two lists: its heading, then one labelled group per category. A section with no
 * rows at all is left out — a heading over nothing says there are none — and so is a category the
 * rule handed over empty.
 */
function Section({
  section,
  controls,
  onOpen,
}: {
  section: SkillSection
  controls?: RowControls
  /** Opening a skill's sheet, where the Host offers one: every row of both sections has this. */
  onOpen?: (name: string) => void
}) {
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
                <SkillItem key={skill.name} skill={skill} controls={controls} onOpen={onOpen} />
              ))}
            </Group>
          </div>
        ))}
      </div>
    </section>
  )
}

/**
 * One skill: its name, the category it sits in, what it is for, how it is doing underneath, and the
 * switch its Host advertises — the same name, badge and description a skill wears in the composer's
 * menu, with the health line an MCP server's row has. The line is the Host's own text where it
 * failed, so it reads as the failure it is.
 *
 * The name is the button that opens the skill's sheet, where the Host offers one — the row's own way
 * in, as a server's name is.
 */
function SkillItem({
  skill,
  controls,
  onOpen,
}: {
  skill: Skill
  controls?: RowControls
  onOpen?: (name: string) => void
}) {
  const health = skillHealth(skill)
  // A row the Host says it will refuse to switch carries none — an essential skill's switch could
  // only come back refused. A row that doesn't say is offered one: a Host that can't answer that is
  // a Host that doesn't advertise `skills_write` either, so a switch here still means something.
  const offers = controls !== undefined && skill.switchable !== false
  const name = (
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
        <RowText
          title={
            onOpen ? (
              <button
                type="button"
                className="max-w-full rounded-lg text-left outline-none hover:underline focus-visible:ring-2 focus-visible:ring-ring"
                aria-haspopup="dialog"
                onClick={() => onOpen(skill.name)}
              >
                {name}
              </button>
            ) : (
              name
            )
          }
          subtitle={skill.description}
        />
        <span
          className={cn("text-sm", health.failed ? "text-destructive" : "text-muted-foreground")}
        >
          {health.text}
        </span>
      </div>
      {offers && (
        <Switch
          aria-label={`${skill.name} on`}
          checked={skill.enabled !== false}
          disabled={controls.saving === skill.name}
          onCheckedChange={(checked) => controls.onToggle(skill.name, checked)}
        />
      )}
    </div>
  )
}

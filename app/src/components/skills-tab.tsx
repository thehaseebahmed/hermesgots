import { SparklesIcon, Trash2Icon } from "lucide-react"
import { useCallback, useState } from "react"
import { toast } from "sonner"

import { SkillDetailSheet } from "@/components/skill-detail-sheet"
import { Group, rowClass, RowText } from "@/components/settings-chrome"
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Switch } from "@/components/ui/switch"
import type { Profile } from "@/lib/db"
import type { Skill } from "@/lib/hermes"
import { useSkillFeatureAnswers, useSkills } from "@/lib/skills"
import { canRemove, skillHealth, skillSections, type SkillSection } from "@/lib/skills-tab"
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
 * What the tab is showing over the list: exactly one sheet, or none. A skill's sheet and the
 * confirmation its Remove opens exclude each other — the removal replaces the sheet and cancelling
 * goes back to it — so one state says what the screen is showing rather than two booleans that have
 * to be kept in agreement.
 */
type Sheet = { kind: "skill"; name: string } | { kind: "remove"; name: string }

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
 * one, and reads that one skill when it opens. The sheet's last action takes the skill away, where
 * its origin has a removal behind it — one word over Hermes's own uninstall and delete — and the
 * Host's remaining list replaces the whole one every consumer reads, so the row goes everywhere.
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
  // While a removal is in flight both dialogs hold still, so a second tap can't ask twice.
  const [pending, setPending] = useState(false)
  const [sheet, setSheet] = useState<Sheet | null>(null)
  // The sheet's way out, held still: it is handed to a sheet that reads its skill once per skill and
  // connection, so a callback drawn afresh on every render of this tab would read it again.
  const close = useCallback(() => setSheet(null), [])
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

  // The Host's own sentence again, and the skill still in the list: the row goes only because the
  // list was replaced with what the Host says is left, never because a removal was asked for. A
  // refused removal closes the confirmation and goes back to the skill's sheet, so the refusal
  // leaves the one thing that was read on screen rather than a dialog with nothing left to answer.
  const confirmRemove = async (name: string) => {
    setPending(true)
    try {
      await state.remove(name)
      setSheet(null)
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Couldn't remove that skill.")
      setSheet({ kind: "skill", name })
    } finally {
      setPending(false)
    }
  }

  const controls = answers.write === "yes" ? { onToggle: toggle, saving } : undefined
  // A sheet only exists where the Host offers a lookup for it, so a row whose title could open
  // nothing keeps its name plain (an older plugin).
  const open =
    answers.view === "yes" ? (name: string) => setSheet({ kind: "skill", name }) : undefined
  // Remove is offered only where the Host advertises a removal and the skill's own origin has one
  // behind it (ADR 0044): the row is the list's, so the two can't disagree about either.
  const opened =
    sheet?.kind === "skill" ? state.skills.find((one) => one.name === sheet.name) : undefined
  const offersRemove = opened !== undefined && answers.remove === "yes" && canRemove(opened)
  // The skill whose Remove is confirmed on screen: the one narrowing of the sheet state that the
  // dialog's open, its title and its confirm all read.
  const removing = sheet?.kind === "remove" ? sheet.name : null
  return (
    <div className="flex flex-col gap-4" data-skills-tab>
      {skillSections(state.skills).map((section) => (
        <Section key={section.id} section={section} controls={controls} onOpen={open} />
      ))}
      {sheet?.kind === "skill" && (
        <SkillDetailSheet
          config={profile}
          name={sheet.name}
          onClose={close}
          footer={
            offersRemove ? (
              <RemoveSkill onRemove={() => setSheet({ kind: "remove", name: sheet.name })} />
            ) : undefined
          }
        />
      )}
      <AlertDialog
        open={removing !== null}
        onOpenChange={(next) => {
          if (next || pending) return
          // Cancelling goes back to the skill's own sheet, the one Remove was offered from.
          setSheet(removing === null ? null : { kind: "skill", name: removing })
        }}
      >
        <AlertDialogContent size="sm">
          <AlertDialogHeader>
            <AlertDialogTitle>
              {removing === null ? "Remove this skill?" : `Remove ${removing}?`}
            </AlertDialogTitle>
            <AlertDialogDescription>
              The bot stops having it, and its files go with it. A Hub skill is uninstalled, and one
              written on the profile is deleted.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={pending}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              disabled={pending}
              onClick={() => removing !== null && void confirmRemove(removing)}
            >
              Remove
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}

/**
 * Taking a skill away: the skill sheet's last button, offered only where the Host has a removal for
 * the skill's origin. One word whatever it does underneath (ADR 0044) — the origin decides which
 * host operation it is, and the confirmation says what will go.
 */
function RemoveSkill({ onRemove }: { onRemove: () => void }) {
  return (
    <Button
      type="button"
      variant="ghost"
      className="h-11 self-start rounded-full text-destructive"
      onClick={onRemove}
    >
      <Trash2Icon data-icon="inline-start" />
      Remove
    </Button>
  )
}

/**
 * One of the tab's two lists: its heading, then one labelled group per category. A section with no
 * rows at all is left out — a heading over nothing says there are none — and it is the only thing
 * left to check, since the rule never hands over a group with no rows in it.
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
  if (section.groups.length === 0) return null
  return (
    <section className="flex flex-col gap-2" data-skill-section={section.id}>
      <h2 className="px-2 text-sm font-medium text-muted-foreground">{section.title}</h2>
      <div className="flex flex-col gap-3">
        {section.groups.map((group) => (
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

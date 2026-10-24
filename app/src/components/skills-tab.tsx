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
import {
  canRemove,
  offersSwitch,
  skillHealth,
  skillSections,
  type RowControls,
  type SkillSection,
} from "@/lib/skills-tab"
import { cn } from "@/lib/utils"

type Sheet = { kind: "skill"; name: string } | { kind: "remove"; name: string }

export function SkillsTab({ profile }: { profile: Profile }) {
  const answers = useSkillFeatureAnswers(profile)
  const answer = answers.list
  const state = useSkills(profile, answer === "yes")
  const [saving, setSaving] = useState<string | null>(null)
  const [pending, setPending] = useState(false)
  const [sheet, setSheet] = useState<Sheet | null>(null)
  const close = useCallback(() => setSheet(null), [])
  if (answer !== "yes") return null
  if (state.status === "loading") return null

  const toggle = async (name: string, enabled: boolean) => {
    setSaving(name)
    try {
      await state.setEnabled(name, enabled)
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Couldn't save that.")
    } finally {
      setSaving(null)
    }
  }

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
  const open =
    answers.view === "yes" ? (name: string) => setSheet({ kind: "skill", name }) : undefined
  const opened =
    sheet?.kind === "skill" ? state.skills.find((one) => one.name === sheet.name) : undefined
  const offersRemove = opened !== undefined && answers.remove === "yes" && canRemove(opened)
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

function Section({
  section,
  controls,
  onOpen,
}: {
  section: SkillSection
  controls?: RowControls
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
  const switchControls = offersSwitch(controls, skill) ? controls : undefined
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
      {switchControls && (
        <Switch
          aria-label={`${skill.name} on`}
          checked={skill.enabled !== false}
          disabled={switchControls.saving === skill.name}
          onCheckedChange={(checked) => switchControls.onToggle(skill.name, checked)}
        />
      )}
    </div>
  )
}

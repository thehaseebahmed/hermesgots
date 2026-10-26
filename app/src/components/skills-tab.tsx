import { useState } from "react"
import { useNavigate } from "react-router"
import { toast } from "sonner"

import { SkillDetail } from "@/components/skill-detail-sheet"
import {
  Caption,
  ConfirmDestructive,
  Group,
  headerRowClass,
  linkRowClass,
  rowClass,
  RowText,
  SplitSwitchRow,
  SwitchRow,
} from "@/components/settings-chrome"
import type { Profile } from "@/lib/db"
import type { Skill } from "@/lib/hermes"
import { useSkillFeatureAnswers, useSkills } from "@/lib/skills"
import {
  canRemove,
  categoryHeader,
  categoryWrites,
  skillHealth,
  skillSections,
  switchableControls,
  type CategoryHeader,
  type RowControls,
  type SkillGroup,
  type SkillSection,
} from "@/lib/skills-tab"
import { cn } from "@/lib/utils"
import { botSubPath, type BotSub } from "@/lib/bot-subs"
import { botTabPath } from "@/lib/bot-tabs"

export function SkillsTab({ profile, sub }: { profile: Profile; sub?: BotSub }) {
  const answers = useSkillFeatureAnswers(profile)
  const answer = answers.list
  const state = useSkills(profile, answer === "yes")
  const navigate = useNavigate()
  const [saving, setSaving] = useState<string | null>(null)
  const [flipping, setFlipping] = useState<string | null>(null)
  const [pending, setPending] = useState(false)
  const [removing, setRemoving] = useState<string | null>(null)
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

  // A category's header is a switch over the whole category, and its tap follows the value the
  // switch shows, as a Notification types feature's does: a category that reads on (any skill in it
  // on) is cleared whole, and one that reads off is filled. Only the rows whose own switch the tap
  // changes are written, one at a time, stopping at the first refusal with the Host's own sentence,
  // as a row's switch does. A skill the Host can't switch is never part of the write.
  const flip = async (key: string, group: SkillGroup) => {
    const target = !categoryHeader(group).checked
    const names = categoryWrites(group, target)
    if (names.length === 0) return
    setFlipping(key)
    try {
      for (const name of names) await state.setEnabled(name, target)
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Couldn't save that.")
    } finally {
      setFlipping(null)
    }
  }

  const confirmRemove = async (name: string) => {
    setPending(true)
    try {
      await state.remove(name)
      // The skill's own note has nothing left to say, so the tab takes the screen back.
      navigate(botTabPath(profile.id, "skills"), { replace: true })
      setRemoving(null)
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Couldn't remove that skill.")
      setRemoving(null)
    } finally {
      setPending(false)
    }
  }

  /** Remove's question: a destructive confirmation, which stays a dialog wherever the note is. */
  const confirmation = (
    <ConfirmDestructive
      open={removing !== null}
      title={`Remove ${removing ?? ""}?`}
      description="The bot stops having it, and its files go with it. A Hub skill is uninstalled, and one written on the profile is deleted."
      confirmLabel="Remove"
      busy={pending}
      onOpenChange={(open) => !open && setRemoving(null)}
      onConfirm={() => removing !== null && void confirmRemove(removing)}
    />
  )

  const controls = answers.write === "yes" ? { onToggle: toggle, saving } : undefined
  // A row's own tap is its note's address: the note is a detail the route draws, not a sheet.
  const open =
    answers.view === "yes"
      ? (name: string) => navigate(botSubPath(profile.id, "skills", name))
      : undefined

  // A detail takes the page's place at either width: below 1024px the route pushed it, and from
  // 1024px it is the pane the list would have drawn in. Remove is still a confirmation, not a page.
  if (sub?.kind === "detail") {
    const opened = state.skills.find((one) => one.name === sub.title)
    const offersRemove = opened !== undefined && answers.remove === "yes" && canRemove(opened)
    return (
      <>
        <SkillDetail
          profile={profile}
          name={sub.title}
          onRemove={offersRemove ? () => setRemoving(sub.title) : undefined}
        />
        {confirmation}
      </>
    )
  }

  return (
    <div className="flex flex-col gap-4" data-skills-tab>
      {skillSections(state.skills).map((section) => (
        <Section
          key={section.id}
          section={section}
          controls={controls}
          onOpen={open}
          onFlip={flip}
          flipping={flipping}
        />
      ))}
      {confirmation}
    </div>
  )
}

function Section({
  section,
  controls,
  onOpen,
  onFlip,
  flipping,
}: {
  section: SkillSection
  controls?: RowControls
  onOpen?: (name: string) => void
  onFlip?: (key: string, group: SkillGroup) => void
  /** The category whose header is mid-write, so its rows wait for it. */
  flipping: string | null
}) {
  if (section.groups.length === 0) return null
  return (
    <section className="flex flex-col gap-2" data-skill-section={section.id}>
      {section.heading && <Caption>{section.heading}</Caption>}
      <div className="flex flex-col gap-3">
        {section.groups.map((group, index) => {
          const key = `${section.id}:${group.category ?? ""}`
          return (
            <div
              key={group.category ?? ""}
              className="flex flex-col"
              data-skill-group={group.category ?? ""}
            >
              <Group>
                <CategoryRow
                  id={`skill-category-${section.id}-${index}`}
                  header={categoryHeader(group)}
                  writable={controls !== undefined}
                  busy={flipping === key}
                  onFlip={() => onFlip?.(key, group)}
                />
                {group.skills.map((skill) => (
                  <SkillItem
                    key={skill.name}
                    skill={skill}
                    controls={controls}
                    onOpen={onOpen}
                    busy={flipping === key}
                  />
                ))}
              </Group>
            </div>
          )
        })}
      </div>
    </section>
  )
}

/**
 * A category's own row, over the skills it holds: the category's name and how much of it is on, and
 * the switch that stands for all of it — or, where the Host has no write, the same line as a plain
 * title over the rows, since there is nothing to switch with.
 */
function CategoryRow({
  id,
  header,
  writable,
  busy,
  onFlip,
}: {
  id: string
  header: CategoryHeader
  writable: boolean
  busy: boolean
  onFlip: () => void
}) {
  if (writable)
    return (
      <div data-skill-category={header.title}>
        <SwitchRow
          id={id}
          variant="header"
          title={header.title}
          subtitle={header.subtitle ?? undefined}
          checked={header.checked}
          disabled={busy}
          onCheckedChange={() => onFlip()}
        />
      </div>
    )
  return (
    <div className={headerRowClass} data-skill-category={header.title}>
      <span className="flex min-w-0 flex-1 flex-col">
        <span className="truncate text-base font-semibold">{header.title}</span>
        {header.subtitle && (
          <span className="line-clamp-2 text-sm text-muted-foreground">{header.subtitle}</span>
        )}
      </span>
    </div>
  )
}

/**
 * One skill's row: its name over its description and the health line under both — two columns where
 * the Host can both open it and switch it, one tap where it can only do one of them, and no control
 * at all where it can do neither.
 */
function SkillItem({
  skill,
  controls,
  onOpen,
  busy,
}: {
  skill: Skill
  controls?: RowControls
  onOpen?: (name: string) => void
  busy: boolean
}) {
  const health = skillHealth(skill)
  const switchControls = switchableControls(controls, skill)
  const line = (
    <span className={cn("text-sm", health.failed ? "text-destructive" : "text-muted-foreground")}>
      {health.text}
    </span>
  )
  const disabled = busy || switchControls?.saving === skill.name
  if (onOpen && switchControls)
    return (
      <div data-skill={skill.name}>
        <SplitSwitchRow
          title={skill.name}
          subtitle={skill.description}
          extra={line}
          switchLabel={`${skill.name} on`}
          checked={skill.enabled !== false}
          disabled={disabled}
          onOpen={() => onOpen(skill.name)}
          onCheckedChange={(checked) => switchControls.onToggle(skill.name, checked)}
        />
      </div>
    )
  if (onOpen)
    return (
      <button
        type="button"
        className={linkRowClass}
        data-skill={skill.name}
        onClick={() => onOpen(skill.name)}
      >
        <span className="flex min-w-0 flex-1 flex-col">
          <RowText title={skill.name} subtitle={skill.description} />
          {line}
        </span>
      </button>
    )
  if (switchControls)
    return (
      <div data-skill={skill.name}>
        <SwitchRow
          id={`skill-switch-${skill.name}`}
          title={skill.name}
          subtitle={skill.description ?? undefined}
          extra={line}
          checked={skill.enabled !== false}
          disabled={disabled}
          onCheckedChange={(checked) => switchControls.onToggle(skill.name, checked)}
        />
      </div>
    )
  return (
    <div className={rowClass} data-skill={skill.name}>
      <div className="flex min-w-0 flex-1 flex-col">
        <RowText
          title={<span className="truncate">{skill.name}</span>}
          subtitle={skill.description}
        />
        {line}
      </div>
    </div>
  )
}

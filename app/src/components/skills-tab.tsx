import { useEffect, useMemo, useState } from "react"
import { useNavigate } from "react-router"

import { Chip, ChipRow } from "@/components/chip"
import { FootSearch, FootSearchClose } from "@/components/foot-search"
import { SearchField } from "@/components/search-field"
import { SkillDetail } from "@/components/skill-detail-sheet"
import { ConfirmDestructive } from "@/components/confirm-destructive"
import {
  Caption,
  Group,
  headerRowClass,
  linkRowClass,
  rowClass,
  RowText,
  SplitSwitchRow,
  SwitchRow,
  useScreenRefusal,
} from "@/components/settings-chrome"
import type { Profile } from "@/lib/db"
import type { Skill } from "@/lib/hermes"
import { useSkillFeatureAnswers, useSkills } from "@/lib/skills"
import {
  ALL_SKILLS_KEY,
  canRemove,
  categoryHeader,
  categoryWrites,
  skillHealth,
  skillPills,
  skillSections,
  skillsKept,
  switchableControls,
  type CategoryHeader,
  type RowControls,
  type SkillGroup,
  type SkillSection,
} from "@/lib/skills-tab"
import { cn } from "@/lib/utils"
import { botSubPath, type BotSub } from "@/lib/bot-subs"
import { botTabPath } from "@/lib/bot-tabs"
import { useXLarge } from "@/lib/media"

/** What a read that hasn't answered holds: one array, so the derivation below isn't rebuilt. */
const NO_SKILLS: Skill[] = []

/**
 * The field's own name, for the control that shows and hides it: the tab's field at a laptop's width
 * and the foot's below it are one field in two places, and only one of the two is ever in the tree
 * (ADR 0145).
 */
const SKILLS_SEARCH_FIELD_ID = "skills-search"

/** The key a section's category is known by: the one a header is busy under, and its full group's. */
const groupKey = (section: string, category: string | null) => `${section}:${category ?? ""}`

export function SkillsTab({ profile, sub }: { profile: Profile; sub?: BotSub }) {
  const answers = useSkillFeatureAnswers(profile)
  const answer = answers.list
  const state = useSkills(profile, answer === "yes")
  const navigate = useNavigate()
  const [saving, setSaving] = useState<string | null>(null)
  const [flipping, setFlipping] = useState<string | null>(null)
  const [pending, setPending] = useState(false)
  const [removing, setRemoving] = useState<string | null>(null)
  const [query, setQuery] = useState("")
  // The page's one refusal, held by the Screen this tab is drawn in.
  const refusal = useScreenRefusal()
  // The pill the reader pressed, by its key: the tab's own, gone when it remounts.
  const [chosen, setChosen] = useState(ALL_SKILLS_KEY)
  // Whether the foot's field is up, which is the only thing the foot holds: the words are the tab's
  // own `query`, since it is the tab's rows they narrow.
  const [seeking, setSeeking] = useState(false)
  // From a laptop's width up the field stands over the pills, and the foot draws no search at all
  // there — one field, in the one place the width puts it (ADR 0145).
  const wide = useXLarge()
  const skills = state.status === "ok" ? state.skills : NO_SKILLS
  // Narrowed before it is grouped, so the sections and their captions describe what is drawn, and
  // memorised so a switch's own state changing does not rebuild them. Each drawn group is matched to
  // the whole category it came from, which is what its header counts and what its tap writes.
  const { pills, kept, sections, whole } = useMemo(() => {
    const pills = skillPills(skills)
    const kept = skillsKept(skills, chosen, query)
    const whole = new Map(
      skillSections(skills).flatMap((section) =>
        section.groups.map((group) => [groupKey(section.id, group.category), group] as const),
      ),
    )
    return { pills, kept, sections: skillSections(kept), whole }
  }, [skills, chosen, query])
  // A category leaves with the last skill in it, and a category that comes back must not be pressed
  // again without a tap: the press is handed back to All as soon as no pill offers it.
  useEffect(() => {
    if (!pills.some((pill) => pill.key === chosen)) setChosen(ALL_SKILLS_KEY)
  }, [pills, chosen])
  if (answer !== "yes") return null
  if (state.status === "loading") return null

  const toggle = async (name: string, enabled: boolean) => {
    setSaving(name)
    await refusal.write("save that", () => state.setEnabled(name, enabled))
    setSaving(null)
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
    await refusal.write("save that", async () => {
      for (const name of names) await state.setEnabled(name, target)
    })
    setFlipping(null)
  }

  // The question holds its own refusal, so the write only has to land or throw.
  const confirmRemove = async (name: string) => {
    setPending(true)
    try {
      await state.remove(name)
      // The skill's own note has nothing left to say, so the tab takes the screen back.
      navigate(botTabPath(profile.id, "skills"), { replace: true })
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
      onConfirm={() => (removing === null ? undefined : confirmRemove(removing))}
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

  // The only emptiness this tab words is the search's: a bot holding no skills draws the field over an
  // empty tab and says nothing, since nothing was searched.
  const missed = kept.length === 0 && query.trim() !== ""

  return (
    <div className="flex flex-1 flex-col gap-4" data-skills-tab>
      <div className="flex flex-col gap-2">
        {/* The pills stand at the top at every width; the field is there only where the width has room
            for it to stand always — below a laptop's it is the foot's. */}
        {wide && (
          <SearchField
            id={SKILLS_SEARCH_FIELD_ID}
            value={query}
            onChange={setQuery}
            label="Search skills"
          />
        )}
        {pills.length > 1 && (
          <ChipRow label="Filter skills">
            {pills.map((pill) => (
              <Chip key={pill.key} active={pill.key === chosen} onClick={() => setChosen(pill.key)}>
                {pill.label}
              </Chip>
            ))}
          </ChipRow>
        )}
      </div>
      {missed && <p className="py-8 text-center text-sm text-muted-foreground">No skills match.</p>}
      {sections.map((section) => (
        <Section
          key={section.id}
          section={section}
          whole={whole}
          controls={controls}
          onOpen={open}
          onFlip={flip}
          flipping={flipping}
        />
      ))}
      {/* The foot, in the chat list's own arrangement: sticky to the foot of the scroll rather than
          fixed, a gradient out of the background so the rows end under it, and the safe area beneath.
          The wrapper is the tab's because a Settings page scrolls as one column (`Screen`), so the bar
          has to be that column's last child; this div's `flex-1` is what lets the foot's `mt-auto` put
          it at the bottom of a tab whose rows stop short of the screen. */}
      {!wide && (
        <div
          data-skills-foot
          className="pointer-events-none sticky bottom-0 z-20 -mx-4 mt-auto bg-gradient-to-t from-background via-background/90 to-transparent px-4 pt-6 pb-[max(1rem,env(safe-area-inset-bottom))]"
        >
          <div className="mx-auto flex w-full max-w-2xl items-center gap-2">
            <FootSearch
              open={seeking}
              onOpen={() => setSeeking(true)}
              onClose={() => setSeeking(false)}
              query={query}
              onQueryChange={setQuery}
              label="Search skills"
              fieldId={SKILLS_SEARCH_FIELD_ID}
            />
            {seeking && <FootSearchClose onClose={() => setSeeking(false)} />}
          </div>
        </div>
      )}
      {confirmation}
    </div>
  )
}

function Section({
  section,
  whole,
  controls,
  onOpen,
  onFlip,
  flipping,
}: {
  section: SkillSection
  /** The whole category each drawn group came from, by the key its header is busy under. */
  whole: Map<string, SkillGroup>
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
          const key = groupKey(section.id, group.category)
          // The rows are the ones the words kept; the header over them, and the tap that header takes,
          // speak for the category they belong to.
          const full = whole.get(key) ?? group
          return (
            <div
              key={group.category ?? ""}
              className="flex flex-col"
              data-skill-group={group.category ?? ""}
            >
              <Group>
                <CategoryRow
                  id={`skill-category-${section.id}-${index}`}
                  header={categoryHeader(full)}
                  writable={controls !== undefined}
                  busy={flipping === key}
                  onFlip={() => onFlip?.(key, full)}
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

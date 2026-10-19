/**
 * AFK: a project's switch for working its own tasks, the skills that work follows, and the tasks it
 * would work — the frontier, what's ready oldest first, what somebody has already claimed, and what
 * an open task still blocks.
 * The switch is the host's setting for the project, so it reads back the same on every device. It is
 * always shown: a project that can't be left to work (or a Bot on a plugin too old to switch one) has
 * it off and disabled, with the reason underneath. Under it sit the two skill pickers — one for the
 * Build, one or more for the Critique — where the plugin advertises `afk_skills`, both listing the
 * bot's own live skills. The frontier is there where the plugin advertises `afk`, the switch where it
 * advertises `afk_switch`.
 */
import { useCallback, useEffect, useRef, useState, type ReactNode } from "react"
import { ChevronDownIcon } from "lucide-react"
import { toast } from "sonner"

import { Popup, PopupContent, PopupHeader, PopupTitle } from "@/components/popup"
import { Button } from "@/components/ui/button"
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { Spinner } from "@/components/ui/spinner"
import { Switch } from "@/components/ui/switch"
import { connectionKey } from "@/lib/connection"
import { cooldown, lacksRoute } from "@/lib/cooldown"
import { usePluginFeature, type PluginFeatureAnswer } from "@/lib/features"
import { AFK_MS, READ_TIMEOUT_MS } from "@/lib/freshness"
import {
  getProjectAfk,
  getProjectTasks,
  setProjectAfk,
  setProjectAfkSkills,
  type HermesConfig,
  type ProjectAfk,
  type ProjectIssue,
  type ProjectTasks,
  type ProjectTask,
  type Skill,
} from "@/lib/hermes"
import { usePoll } from "@/lib/poll"
import { noteFailure } from "@/lib/report"
import { useSkills } from "@/lib/skills"

/** The feature the plugin advertises when it can read a project's tasks. */
export const AFK_FEATURE = "afk"

/** And the one it advertises when it can turn the switch on and off. */
export const AFK_SWITCH_FEATURE = "afk_switch"

/** And the one it advertises when it can keep the skills a project's work follows. */
export const AFK_SKILLS_FEATURE = "afk_skills"

/** A Bot whose plugin answers without the route is left alone for a while, like every other read. */
const unsupported = cooldown()

const GROUPS = [
  { key: "ready", label: "Ready" },
  { key: "claimed", label: "Claimed" },
  { key: "blocked", label: "Blocked" },
] as const

export function AfkPopup({
  open,
  onOpenChange,
  config,
  projectId,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  config: HermesConfig
  projectId: string
}) {
  const [tasks, setTasks] = useState<ProjectTasks>()
  const [error, setError] = useState<string>()
  const [afk, setAfk] = useState<ProjectAfk>()
  const [afkError, setAfkError] = useState<string>()
  const [saving, setSaving] = useState(false)
  const key = connectionKey(config)
  const switchable = usePluginFeature(config, AFK_SWITCH_FEATURE)
  const withSkills = usePluginFeature(config, AFK_SKILLS_FEATURE)
  // The pickers' list is the bot's own skills, read the way the composer's `/` menu reads them: only
  // what this profile can run now. Asked only where the host can hold a choice at all.
  const skills = useSkills(config, open && withSkills === "yes")

  const read = useCallback(
    (signal: AbortSignal) => {
      if (unsupported.cooling(key)) return
      // A read that never answers is treated as lost rather than left hanging on the host.
      void getProjectTasks(
        config,
        projectId,
        AbortSignal.any([signal, AbortSignal.timeout(READ_TIMEOUT_MS)]),
      )
        .then((next) => {
          unsupported.clear(key)
          if (signal.aborted) return
          // The answer replaces the last failure too: what's on screen is the list it brought.
          setError(undefined)
          setTasks(next)
        })
        .catch((failure: unknown) => {
          if (signal.aborted) return
          setError(
            failure instanceof Error ? failure.message : "Couldn't read the project's tasks.",
          )
          noteFailure("Reading the project's tasks", failure)
          void lacksRoute(config, failure, AFK_FEATURE).then((missing) => {
            if (missing) unsupported.start(key)
          })
        })
    },
    [config, key, projectId],
  )
  // Read once each time the sheet opens — and again for another project — never on a timer.
  usePoll(read, false, [projectId], { active: open, onShow: false })

  const readAfk = useCallback(
    (signal: AbortSignal) => {
      if (unsupported.cooling(key)) return
      void getProjectAfk(
        config,
        projectId,
        AbortSignal.any([signal, AbortSignal.timeout(READ_TIMEOUT_MS)]),
      )
        .then((next) => {
          unsupported.clear(key)
          if (signal.aborted) return
          // The answer clears the last failure: what the sheet shows is what the host just said.
          setAfkError(undefined)
          setAfk(next)
        })
        .catch((failure: unknown) => {
          if (signal.aborted) return
          setAfkError(failure instanceof Error ? failure.message : "Couldn't read AFK's setting.")
          noteFailure("Reading AFK's setting", failure)
          void lacksRoute(config, failure, AFK_SWITCH_FEATURE).then((missing) => {
            if (missing) unsupported.start(key)
          })
        })
    },
    [config, key, projectId],
  )
  // The switch's own read, only where the plugin has it: a Host that can't answer is never asked.
  // While the project is off nothing here can change but the user's own write, so there is no timer;
  // once it's on the sheet keeps reading at AFK_MS, because turning it on wakes a sweep on the host
  // and the task it claims, or why GitHub refused it, lands after the switch's own answer.
  usePoll(readAfk, afk?.on ? AFK_MS : false, [key, projectId], {
    active: open && switchable === "yes",
    onShow: false,
  })

  // Taking a task moves it out of the frontier, so the list is read again when AFK's answer names
  // the one it holds — and when it lets one go, which puts it back. Not when the frontier already
  // has it claimed: that read is the same list, only fresher.
  const held = afk?.task ? `${afk.task.repo}#${afk.task.number}` : ""
  const listed =
    Boolean(held) && Boolean(tasks?.claimed.some((row) => `${row.repo}#${row.number}` === held))
  const seen = useRef(held)
  useEffect(() => {
    if (seen.current === held) return
    seen.current = held
    if (listed) return
    const controller = new AbortController()
    read(controller.signal)
    return () => controller.abort()
  }, [held, listed, read])

  const turn = async (on: boolean) => {
    setSaving(true)
    try {
      // The host's answer is what the switch shows: a write it refused never reads back as done.
      setAfk(await setProjectAfk(config, projectId, on))
    } catch (failure) {
      toast.error(failure instanceof Error ? failure.message : "Couldn't save that.")
    } finally {
      setSaving(false)
    }
  }

  // The same for a skill choice, which is the project's too — one write naming both pickers, since
  // only one of them changes and the other has to keep what it had.
  const choose = async (buildSkill: string | null, critiqueSkills: string[]) => {
    setSaving(true)
    try {
      setAfk(await setProjectAfkSkills(config, projectId, buildSkill, critiqueSkills))
    } catch (failure) {
      toast.error(failure instanceof Error ? failure.message : "Couldn't save that.")
    } finally {
      setSaving(false)
    }
  }

  const manyRepos = (tasks?.repos.length ?? 0) > 1

  return (
    <Popup open={open} onOpenChange={onOpenChange}>
      <PopupContent>
        <PopupHeader className="pb-2">
          <PopupTitle>Away From Keyboard</PopupTitle>
        </PopupHeader>
        <div className="flex flex-col gap-6 px-4 pb-4 sm:px-6">
          <AfkSwitch
            answer={switchable}
            afk={afk}
            error={afkError}
            saving={saving}
            onToggle={(on) => void turn(on)}
          />
          {/* Under the switch, because it is the same setting: what the work does when it is left
              to run. A choice is the project's even with nothing left to work. */}
          {withSkills === "yes" && afk && !afkError && skills.status === "ok" && (
            <AfkSkills
              afk={afk}
              skills={skills.skills}
              saving={saving}
              onChoose={(buildSkill, critiqueSkills) => void choose(buildSkill, critiqueSkills)}
            />
          )}
          {/* Only a project left to work has anything to say here: a task held under an off switch
              reads as still working. */}
          {afk?.on && <Working task={afk.task} refusal={afk.refusal} manyRepos={manyRepos} />}
          <Tasks
            tasks={tasks}
            error={error}
            // Said twice only when it is the same thing said: the switch's reason can differ from why
            // the frontier failed, and then it is two different facts, not one repeated.
            duplicate={Boolean(afk?.reason) && afk?.reason === error}
            manyRepos={manyRepos}
          />
        </div>
      </PopupContent>
    </Popup>
  )
}

/**
 * The switch, and what stopped it where something did. It is always in place — a project that can't be
 * left to work, a plugin that can't switch it and a read that failed all show it off and out of reach,
 * with the reason under it — so the row doesn't appear and disappear between projects. A project
 * already left to work keeps its switch live even once its reason is back (the account it read tasks
 * with is gone, say): turning it off is still the user's to do.
 *
 * The label reads the switch's state ("Turned off", "Turned on"); the control's own name stays what it
 * does, so assistive tech hears the name and its checked state rather than a name that changes.
 */
function AfkSwitch({
  answer,
  afk,
  error,
  saving,
  onToggle,
}: {
  answer: PluginFeatureAnswer
  afk: ProjectAfk | undefined
  error: string | undefined
  saving: boolean
  onToggle: (on: boolean) => void
}) {
  const reason = afk?.reason ?? undefined
  const on = afk?.on ?? false
  // The host has to say the project can be worked, and the switch has to have been read back.
  const canSwitch = answer === "yes" && Boolean(afk) && !saving && !error && (on || !reason)
  const reading = answer === "yes" && !afk && !error
  return (
    <div className="flex flex-col gap-1">
      <div className="flex min-h-11 items-center justify-between gap-3 px-1">
        <span className="text-base">{on ? "Turned on" : "Turned off"}</span>
        {reading ? (
          <Spinner className="size-4" />
        ) : (
          <Switch
            aria-label="Work on its own"
            checked={on}
            disabled={!canSwitch}
            onCheckedChange={onToggle}
          />
        )}
      </div>
      {error ? (
        <p className="px-1 text-sm text-destructive">{error}</p>
      ) : (
        reason && (
          <p className="px-1 text-sm text-muted-foreground" role="status">
            {reason}
          </p>
        )
      )}
    </div>
  )
}

/**
 * The skills this project's AFK work follows: the one that governs how a task is built, and the ones
 * its critique follows. Both lists are the bot's own live skills, read the way the composer's `/`
 * menu reads them, and the choice is the project's — kept on its host, so a reload, another device
 * and a restarted host read the same one back. Either is left at None by default: nothing chosen
 * works the way AFK always has.
 *
 * A name the profile has since lost stays on the row and shows here, so the project says what it
 * holds; the pickers still offer only what the bot can run now, and Clear takes the lost one away.
 */
function AfkSkills({
  afk,
  skills,
  saving,
  onChoose,
}: {
  afk: ProjectAfk
  skills: Skill[]
  saving: boolean
  onChoose: (buildSkill: string | null, critiqueSkills: string[]) => void
}) {
  const critique = afk.critiqueSkills
  const names = skills.map((skill) => skill.name)
  return (
    <div className="flex flex-col gap-1" data-afk-skills>
      <div className="flex min-h-11 items-center justify-between gap-3 px-1">
        <span className="text-base">Build</span>
        <Select
          value={afk.buildSkill}
          items={[
            { value: null, label: "None" },
            ...names.map((name) => ({ value: name, label: name })),
          ]}
          onValueChange={(value) => onChoose(typeof value === "string" ? value : null, critique)}
        >
          <SelectTrigger aria-label="Build skill" className="h-11 max-w-52" disabled={saving}>
            {/* The stored name shows even when the profile has lost it: the row names the project's
                choice rather than reading as nothing chosen. */}
            <SelectValue>
              {(value) => (typeof value === "string" && value ? value : "None")}
            </SelectValue>
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={null}>None</SelectItem>
            {names.map((name) => (
              <SelectItem key={name} value={name}>
                {name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
      <div className="flex min-h-11 items-center justify-between gap-3 px-1">
        <span className="text-base">Critique</span>
        <DropdownMenu>
          <DropdownMenuTrigger
            render={
              <Button
                type="button"
                variant="secondary"
                aria-label="Critique skills"
                className="h-auto min-h-11 max-w-52 gap-2 rounded-4xl py-2 pr-2.5 pl-3 font-normal"
                disabled={saving || (names.length === 0 && critique.length === 0)}
              />
            }
          >
            <span className="truncate">{critique.length > 0 ? critique.join(", ") : "None"}</span>
            <ChevronDownIcon className="shrink-0 text-muted-foreground" />
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="max-h-80 min-w-52 overflow-y-auto">
            {names.map((name) => {
              const picked = critique.includes(name)
              return (
                <DropdownMenuCheckboxItem
                  key={name}
                  checked={picked}
                  // The menu stays open for the next lens: picking the critique is picking several.
                  closeOnClick={false}
                  className="min-h-11"
                  onCheckedChange={(checked) =>
                    onChoose(
                      afk.buildSkill,
                      checked ? [...critique, name] : critique.filter((one) => one !== name),
                    )
                  }
                >
                  {name}
                </DropdownMenuCheckboxItem>
              )
            })}
            {critique.length > 0 && (
              <>
                <DropdownMenuSeparator />
                <DropdownMenuItem className="min-h-11" onClick={() => onChoose(afk.buildSkill, [])}>
                  Clear
                </DropdownMenuItem>
              </>
            )}
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    </div>
  )
}

/**
 * What the sweep is doing: the task AFK holds, and why GitHub last refused it. Neither is the
 * switch's own reason — a refusal leaves the switch on — so they read as the sweep's answer rather
 * than as the project's, and both simply disappear when there is nothing to say. A project that
 * isn't left to work says nothing: the task it holds is released with the claim (#270), not here.
 */
function Working({
  task,
  refusal,
  manyRepos,
}: {
  task: ProjectIssue | null | undefined
  refusal: string | null | undefined
  manyRepos: boolean
}) {
  if (!task && !refusal) return null
  return (
    <div className="flex flex-col gap-3">
      {refusal && (
        <p data-refusal className="px-1 text-sm text-destructive" role="status">
          {refusal}
        </p>
      )}
      {task && (
        <section aria-label="Working" data-working>
          <h3 className="px-1 pb-1 text-sm text-muted-foreground">Working</h3>
          <TaskLink task={task} note={manyRepos ? task.repo : undefined} />
        </section>
      )}
    </div>
  )
}

/** The groups that hold something, or the one line that says why none does. */
function Tasks({
  tasks,
  error,
  duplicate,
  manyRepos,
}: {
  tasks: ProjectTasks | undefined
  error: string | undefined
  duplicate: boolean
  manyRepos: boolean
}) {
  // A frontier failure the switch's own reason already says isn't an error the user needs twice — and
  // nothing is coming, so the row is left out rather than spinning over a read that failed.
  if (error) return duplicate ? null : <p className="px-1 text-sm text-destructive">{error}</p>
  if (!tasks) {
    return (
      <p className="flex items-center gap-2 px-1 text-sm text-muted-foreground">
        <Spinner className="size-4" /> Reading tasks…
      </p>
    )
  }
  const groups = GROUPS.filter((group) => tasks[group.key].length > 0)
  if (!groups.length) return <p className="px-1 text-sm text-muted-foreground">No ready tasks.</p>
  return (
    <>
      {groups.map((group) => (
        <section key={group.key} aria-label={group.label} data-group={group.key}>
          <h3 className="px-1 pb-1 text-sm text-muted-foreground">
            {group.label} ({tasks[group.key].length})
          </h3>
          <ul>
            {tasks[group.key].map((task) => (
              <TaskRow
                key={`${task.repo}#${task.number}`}
                task={task}
                claimed={group.key === "claimed"}
                manyRepos={manyRepos}
              />
            ))}
          </ul>
        </section>
      ))}
    </>
  )
}

/** One issue as the sheet shows it: its number and title, opening it on GitHub, a note under it. */
function TaskLink({
  task,
  note,
  badge,
}: {
  task: ProjectIssue
  note?: ReactNode
  badge?: ReactNode
}) {
  return (
    <a
      href={task.url ?? undefined}
      target="_blank"
      rel="noreferrer"
      data-task={task.number}
      className="flex min-h-11 flex-col justify-center gap-0.5 rounded-2xl px-3 py-2 outline-none hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring"
    >
      <span className="flex min-w-0 items-start gap-2">
        <span className="shrink-0 pt-0.5 font-mono text-xs text-muted-foreground">
          #{task.number}
        </span>
        <span className="min-w-0 flex-1 text-base leading-snug break-words">{task.title}</span>
        {badge}
      </span>
      {note && <span className="pl-8 text-sm text-muted-foreground">{note}</span>}
    </a>
  )
}

function TaskRow({
  task,
  claimed,
  manyRepos,
}: {
  task: ProjectTask
  claimed: boolean
  manyRepos: boolean
}) {
  const note: ReactNode[] = []
  if (manyRepos && task.repo) note.push(task.repo)
  if (task.blockers.length) note.push(`Blocked by ${blockerNames(task)}`)
  return (
    <li>
      <TaskLink
        task={task}
        note={note.length > 0 ? note.join(" · ") : undefined}
        badge={
          claimed ? (
            <span className="shrink-0 rounded-full bg-muted px-2.5 py-1 text-xs text-muted-foreground">
              {task.assignees[0] ?? "Claimed"}
            </span>
          ) : undefined
        }
      />
    </li>
  )
}

/** The blockers still open, by number — `owner/repo#n` for one on another repository. */
function blockerNames(task: ProjectTask) {
  return task.blockers
    .map((blocker: ProjectIssue) =>
      blocker.repo && blocker.repo !== task.repo
        ? `${blocker.repo}#${blocker.number}`
        : `#${blocker.number}`,
    )
    .join(", ")
}

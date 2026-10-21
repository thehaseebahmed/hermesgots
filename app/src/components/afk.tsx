/**
 * AFK: a project's switch for working its own tasks, and the tasks it would work — the frontier,
 * what's ready oldest first, what somebody has already claimed, and what an open task still blocks.
 * The switch is the host's setting for the project, so it reads back the same on every device. It is
 * always shown: a project that can't be left to work (or a Bot on a plugin too old to switch one) has
 * it off and disabled, with the reason underneath. The frontier is there where the plugin advertises
 * `afk`, the switch where it advertises `afk_switch`. The workflow library — the Workflow row, its
 * sheet and the editor — is there only where the plugin also advertises `afk_workflows` and the
 * device's Developer setting offers it; a project on a pick keeps running it either way, because
 * that is the host's record and not this screen's. With that library off, a plugin that advertises
 * `afk_prompt` draws the Prompt row instead: the project's words for how its work is carried out,
 * opened in its own sheet.
 */
import { useCallback, useEffect, useRef, useState, type ReactNode } from "react"
import { ChevronDownIcon, ChevronRightIcon } from "lucide-react"
import { toast } from "sonner"

import { PromptEditor } from "@/components/afk-prompt"
import { RowText } from "@/components/settings-chrome"
import { Popup, PopupContent, PopupHeader, PopupTitle } from "@/components/popup"
import { WorkflowEditor } from "@/components/workflow-editor"
import { WorkflowSheet } from "@/components/workflow-sheet"
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
import { Separator } from "@/components/ui/separator"
import { Spinner } from "@/components/ui/spinner"
import { Switch } from "@/components/ui/switch"
import { connectionKey } from "@/lib/connection"
import { cooldown, lacksRoute } from "@/lib/cooldown"
import { useAfkWorkflowsOn } from "@/lib/afk-workflows"
import { usePluginFeature, usePluginFeatureOn, type PluginFeatureAnswer } from "@/lib/features"
import { AFK_MS, READ_TIMEOUT_MS } from "@/lib/freshness"
import {
  createWorkflow,
  deleteWorkflow,
  getProjectAfk,
  getProjectTasks,
  listWorkflows,
  setProjectAfk,
  setProjectAfkPrompt,
  setProjectAfkSkills,
  setProjectAfkWorkflow,
  updateWorkflow,
  type HermesConfig,
  type ProjectAfk,
  type ProjectIssue,
  type ProjectTasks,
  type ProjectTask,
  type Skill,
} from "@/lib/hermes"
import { STAGE_WORDS, type AfkStage } from "@/lib/pipeline"
import { usePoll } from "@/lib/poll"
import { noteFailure } from "@/lib/report"
import { useSkills } from "@/lib/skills"
import { workflowShape, type Workflow, type WorkflowEntry } from "@/lib/workflow"

/** The feature the plugin advertises when it can read a project's tasks. */
export const AFK_FEATURE = "afk"

/** And the one it advertises when it can turn the switch on and off. */
export const AFK_SWITCH_FEATURE = "afk_switch"

/** And the one it advertises when it can keep the skills a project's work follows. */
export const AFK_SKILLS_FEATURE = "afk_skills"

export const AFK_WORKFLOWS_FEATURE = "afk_workflows"

/** And the one it advertises when it holds the Prompt a project's runs are told. */
export const AFK_PROMPT_FEATURE = "afk_prompt"

/**
 * What a staged task's stage reads as in the Working row: the stage itself is the host's, and a
 * project with no critique skill has none to name. `done` has no word here — nothing is held by
 * then, so this row never says it.
 */
const STAGE_LABELS: Record<AfkStage, string | null> = { ...STAGE_WORDS, done: null }

/** A Bot whose plugin answers without the route is left alone for a while, like every other read. */
const unsupported = cooldown()

const GROUPS = [
  { key: "ready", label: "Ready" },
  { key: "claimed", label: "Claimed" },
  { key: "blocked", label: "Blocked" },
] as const

function useLibraryOffered(config: HermesConfig) {
  const offered = usePluginFeatureOn(config, AFK_WORKFLOWS_FEATURE)
  const on = useAfkWorkflowsOn()
  return offered && on
}

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
  // The workflow library, read when a sheet needs it: the picker and the editor share one list, so a
  // save in either shows at once.
  const [library, setLibrary] = useState<WorkflowEntry[]>()
  const [libraryError, setLibraryError] = useState<string>()
  const [libraryOpen, setLibraryOpen] = useState(false)
  const [editing, setEditing] = useState<WorkflowEntry | "new" | null>(null)
  const [savingWorkflow, setSavingWorkflow] = useState(false)
  const [promptOpen, setPromptOpen] = useState(false)
  const key = connectionKey(config)
  const switchable = usePluginFeature(config, AFK_SWITCH_FEATURE)
  const withSkills = usePluginFeature(config, AFK_SKILLS_FEATURE)
  const libraryOffered = useLibraryOffered(config)
  const withPrompt = usePluginFeature(config, AFK_PROMPT_FEATURE)
  // One row or the other: the library offered is a project running stages, and the Prompt is the
  // words a project running one run is told instead.
  const promptOffered = withPrompt === "yes" && !libraryOffered
  // A Prompt names its own skills in its words, so the build and critique pickers are not drawn beside
  // it and their list is not read: it is the workflow's own choice.
  const skillsDrawn = withSkills === "yes" && !promptOffered
  // The pickers' list is the bot's own skills, read the way the composer's `/` menu reads them: only
  // what this profile can run now. Asked only where the host can hold a choice at all.
  const skills = useSkills(config, open && (skillsDrawn || libraryOffered))
  // The device can turn the switch off from another screen while a sheet is open, or turn the
  // workflow library on, which takes the Prompt row's place.
  if (!libraryOffered && (libraryOpen || editing !== null)) {
    setLibraryOpen(false)
    setEditing(null)
  }
  if (!promptOffered && promptOpen) setPromptOpen(false)

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
  const readLibrary = useCallback(
    (signal: AbortSignal) => {
      void listWorkflows(config, AbortSignal.any([signal, AbortSignal.timeout(READ_TIMEOUT_MS)]))
        .then((next) => {
          if (signal.aborted) return
          setLibraryError(undefined)
          setLibrary(next)
        })
        .catch((failure: unknown) => {
          if (signal.aborted) return
          setLibraryError(
            failure instanceof Error ? failure.message : "Couldn't read the workflows.",
          )
          noteFailure("Reading the workflows", failure)
        })
    },
    [config],
  )
  // Read while a sheet that draws it is open, and again when one opens: a workflow saved on another
  // device shows the next time the sheet is looked at.
  usePoll(readLibrary, false, [key], {
    active: open && libraryOffered && (libraryOpen || editing !== null),
    onShow: false,
  })

  // The switch's own read, only where the plugin has it: a Host that can't answer is never asked.
  // While the project is off nothing here can change but the user's own write, so there is no timer;
  // once it's on the sheet keeps reading at AFK_MS, because turning it on wakes a sweep on the host
  // and the task it claims, or why GitHub refused it, lands after the switch's own answer.
  usePoll(readAfk, afk?.on ? AFK_MS : false, [key, projectId], {
    active:
      open && (switchable === "yes" || withSkills === "yes" || libraryOffered || promptOffered),
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

  // Every write shows the host's answer: a write it refused never reads back as done.
  const save = async (write: () => Promise<ProjectAfk>) => {
    setSaving(true)
    try {
      setAfk(await write())
    } catch (failure) {
      toast.error(failure instanceof Error ? failure.message : "Couldn't save that.")
    } finally {
      setSaving(false)
    }
  }
  const turn = (on: boolean) => save(() => setProjectAfk(config, projectId, on))
  const choose = (buildSkill: string | null, critiqueSkills: string[]) =>
    save(() => setProjectAfkSkills(config, projectId, buildSkill, critiqueSkills))
  // A refusal is the host's, said here the way the other writes are, and answered to the editor so it
  // keeps the words typed rather than closing on a fail.
  const writePrompt = async (prompt: string): Promise<"saved" | "refused"> => {
    try {
      setAfk(await setProjectAfkPrompt(config, projectId, prompt))
      return "saved"
    } catch (failure) {
      toast.error(failure instanceof Error ? failure.message : "Couldn't save that Prompt.")
      return "refused"
    }
  }

  const pickWorkflow = async (picked: WorkflowEntry) => {
    setSavingWorkflow(true)
    try {
      setAfk(await setProjectAfkWorkflow(config, projectId, picked.id))
      setLibraryOpen(false)
    } catch (failure) {
      toast.error(failure instanceof Error ? failure.message : "Couldn't choose that workflow.")
    } finally {
      setSavingWorkflow(false)
    }
  }
  // Both writes answer the library as the host holds it, so the sheet draws the row it wrote —
  // including the copy a preset's save forked.
  const writeWorkflow = async (body: Workflow, id: string | null) => {
    const next = id ? await updateWorkflow(config, id, body) : await createWorkflow(config, body)
    setLibrary(next)
    setLibraryError(undefined)
  }
  const removeWorkflow = async (entry: WorkflowEntry) => {
    try {
      setLibrary(await deleteWorkflow(config, entry.id))
      setEditing(null)
      // The project may have run under it: the host answers what it holds now.
      setAfk(await getProjectAfk(config, projectId))
    } catch (failure) {
      toast.error(failure instanceof Error ? failure.message : "Couldn't delete that workflow.")
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
          {/* The switch and the Prompt it writes for are one list: the row sits under the switch with
              nothing but its own item padding between them. */}
          <div className="flex flex-col">
            <AfkSwitch
              answer={switchable}
              afk={afk}
              error={afkError}
              saving={saving}
              onToggle={(on) => void turn(on)}
            />
            {promptOffered && afk && !afkError && (
              <PromptRow prompt={afk.prompt} onOpen={() => setPromptOpen(true)} />
            )}
          </div>
          {libraryOffered && afk && !afkError && (
            <WorkflowRow workflow={afk.workflow} onOpen={() => setLibraryOpen(true)} />
          )}
          {skillsDrawn && afk && !afkError && (
            <AfkSkills
              afk={afk}
              skills={skills.status === "ok" ? skills.skills : []}
              loading={skills.status === "loading"}
              onChoose={choose}
            />
          )}
          {/* Only a project left to work has anything to say here: a task held under an off switch
              reads as still working. */}
          {afk?.on && (
            <Working
              task={afk.task}
              stage={afk.stage}
              stageName={afk.stageName}
              refusal={afk.refusal}
              manyRepos={manyRepos}
            />
          )}
          <Tasks
            tasks={tasks}
            error={error}
            // Said twice only when it is the same thing said: the switch's reason can differ from why
            // the frontier failed, and then it is two different facts, not one repeated.
            duplicate={Boolean(afk?.reason) && afk?.reason === error}
            manyRepos={manyRepos}
          />
        </div>
        {libraryOffered && (
          <>
            <WorkflowSheet
              open={libraryOpen}
              onOpenChange={setLibraryOpen}
              entries={library}
              error={libraryError}
              chosenId={afk?.workflow?.id}
              saving={savingWorkflow}
              onPick={(entry) => void pickWorkflow(entry)}
              onEdit={(entry) => {
                setLibraryOpen(false)
                setEditing(entry)
              }}
              onNew={() => {
                setLibraryOpen(false)
                setEditing("new")
              }}
            />
            <WorkflowEditor
              // Keyed by what it edits: opening on another workflow starts a fresh draft, and
              // reopening one starts from the row as the host holds it.
              key={editing === null ? "closed" : editing === "new" ? "new" : editing.id}
              open={editing !== null}
              onOpenChange={(next) => !next && setEditing(null)}
              entry={editing === "new" ? null : editing}
              skills={skills.status === "ok" ? skills.skills : []}
              skillsLoading={skills.status === "loading"}
              onSave={writeWorkflow}
              onDelete={removeWorkflow}
            />
          </>
        )}
        {promptOffered && (
          <PromptEditor
            open={promptOpen}
            onOpenChange={setPromptOpen}
            prompt={afk?.prompt ?? ""}
            onSave={writePrompt}
          />
        )}
      </PopupContent>
    </Popup>
  )
}

type Choice = Pick<ProjectAfk, "buildSkill" | "critiqueSkills">

function sameNames(one: string[], other: string[]) {
  return one.length === other.length && one.every((name, index) => name === other[index])
}

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex min-h-11 items-center justify-between gap-3 px-1">
      <span className="text-base">{label}</span>
      {children}
    </div>
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
    <div className="flex flex-col gap-1" data-afk-switch>
      <Row label={on ? "Turned on" : "Turned off"}>
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
      </Row>
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
 * The workflow this project's work runs under, and its shape under its name: the row opens the
 * library, where picking one is one write. A project nothing has chosen for runs the host's default,
 * which it names here rather than leaving the row blank.
 */
function WorkflowRow({ workflow, onOpen }: { workflow: WorkflowEntry | null; onOpen: () => void }) {
  return (
    <div className="flex flex-col gap-1" data-afk-workflow>
      <Row label="Workflow">
        <Button
          type="button"
          variant="secondary"
          aria-label="Workflow"
          className="h-auto min-h-11 max-w-[60%] justify-between gap-2 rounded-4xl py-2 pr-2.5 pl-3 font-normal"
          onClick={onOpen}
        >
          <span className="min-w-0 truncate">{workflow?.name ?? "Default"}</span>
          <ChevronDownIcon className="shrink-0 text-muted-foreground" />
        </Button>
      </Row>
      {workflow && (
        <p className="truncate px-1 text-sm text-muted-foreground">
          {workflowShape(workflow.stages)}
        </p>
      )}
    </div>
  )
}

/**
 * How this project's work is carried out, as the host answers it: the row opens the editor, where the
 * words are written. The host answers its default method where the project wrote none, so an
 * untouched project says what its next run will be told rather than reading as empty.
 */
function PromptRow({ prompt, onOpen }: { prompt: string; onOpen: () => void }) {
  return (
    <button
      type="button"
      data-afk-prompt
      aria-label="Prompt"
      onClick={onOpen}
      className="flex min-h-11 w-full items-center gap-3 rounded-2xl px-1 text-left outline-none hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring"
    >
      <RowText title="Prompt" subtitle={promptLine(prompt)} />
      <ChevronRightIcon className="shrink-0 text-muted-foreground" />
    </button>
  )
}

/**
 * The row's own line for a Prompt: markdown's block marks taken off and its lines run together, since
 * the row names the instruction rather than drawing it — the editor is where it reads as written.
 */
function promptLine(prompt: string) {
  return prompt
    .split("\n")
    .map((line) => line.replace(/^\s*(#{1,6}|[-*+]|\d+\.)\s+/, "").trim())
    .filter(Boolean)
    .join(" · ")
}

/**
 * The skills this project's work follows, kept on its host with the switch. A name the profile has
 * since lost still shows on the row, so the project says what it holds; the menus offer only what the
 * bot can run now.
 */
function AfkSkills({
  afk,
  skills,
  loading,
  onChoose,
}: {
  afk: ProjectAfk
  skills: Skill[]
  /** The bot's list is still being read: the rows wait rather than offering nothing to pick. */
  loading: boolean
  onChoose: (buildSkill: string | null, critiqueSkills: string[]) => Promise<void>
}) {
  // What the rows show while a write is on its way. The host's answer is a round trip behind, so a
  // second tick inside that window would recompute from the list before the first one landed and
  // drop the pick between them: the draft is the truth until the write that carried it comes back.
  const [draft, setDraft] = useState<Choice | null>(null)
  const chosen = draft ?? afk
  const queued = useRef<Choice | null>(null)
  const writes = useRef<Promise<void>>(Promise.resolve())
  const names = skills.map((skill) => skill.name)

  const write = (next: Choice) => {
    // A tick that changes nothing is no write: re-picking the value a row already holds would be a
    // request, a row rewritten on the host and a fresh answer, all for the same setting.
    if (
      next.buildSkill === chosen.buildSkill &&
      sameNames(next.critiqueSkills, chosen.critiqueSkills)
    )
      return
    setDraft(next)
    queued.current = next
    // One write at a time, in the order the ticks came: the answer to the second must not land
    // before the first, or the row would read a list from before the last pick.
    writes.current = writes.current.then(async () => {
      await onChoose(next.buildSkill, next.critiqueSkills)
      // A newer draft is still the user's; otherwise the host's answer takes the row over.
      if (queued.current === next) {
        queued.current = null
        setDraft(null)
      }
    })
  }

  return (
    <div className="flex flex-col gap-2" data-afk-skills>
      <h3 className="px-1 pb-1 text-sm text-muted-foreground">Skills</h3>
      <div className="flex flex-col gap-1">
        <Row label="Build">
          {loading ? (
            <Spinner className="size-4" />
          ) : (
            <Select
              value={chosen.buildSkill}
              items={[
                { value: null, label: "None" },
                ...names.map((name) => ({ value: name, label: name })),
              ]}
              onValueChange={(value) =>
                write({
                  buildSkill: typeof value === "string" ? value : null,
                  critiqueSkills: chosen.critiqueSkills,
                })
              }
            >
              <SelectTrigger aria-label="Build skill" className="h-11 w-52">
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
          )}
        </Row>
        <Row label="Critique">
          {loading ? (
            <Spinner className="size-4" />
          ) : (
            <DropdownMenu>
              <DropdownMenuTrigger
                render={
                  <Button
                    type="button"
                    variant="secondary"
                    aria-label="Critique skills"
                    className="h-auto min-h-11 w-52 justify-between gap-2 rounded-4xl py-2 pr-2.5 pl-3 font-normal"
                    disabled={names.length === 0 && chosen.critiqueSkills.length === 0}
                  />
                }
              >
                <span className="min-w-0 truncate">
                  {chosen.critiqueSkills.length > 0 ? chosen.critiqueSkills.join(", ") : "None"}
                </span>
                <ChevronDownIcon className="shrink-0 text-muted-foreground" />
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="max-h-80 min-w-52 overflow-y-auto">
                {names.map((name) => {
                  const picked = chosen.critiqueSkills.includes(name)
                  return (
                    <DropdownMenuCheckboxItem
                      key={name}
                      checked={picked}
                      // The menu stays open for the next lens: picking the critique is picking several.
                      closeOnClick={false}
                      className="min-h-11"
                      onCheckedChange={(checked) =>
                        write({
                          buildSkill: chosen.buildSkill,
                          critiqueSkills: checked
                            ? [...chosen.critiqueSkills, name]
                            : chosen.critiqueSkills.filter((one) => one !== name),
                        })
                      }
                    >
                      {name}
                    </DropdownMenuCheckboxItem>
                  )
                })}
                {chosen.critiqueSkills.length > 0 && (
                  <>
                    <DropdownMenuSeparator />
                    <DropdownMenuItem
                      className="min-h-11"
                      onClick={() => write({ buildSkill: chosen.buildSkill, critiqueSkills: [] })}
                    >
                      Clear
                    </DropdownMenuItem>
                  </>
                )}
              </DropdownMenuContent>
            </DropdownMenu>
          )}
        </Row>
      </div>
      <Separator />
    </div>
  )
}

/**
 * What the sweep is doing: the task AFK holds, the stage it is in, and why GitHub last refused it.
 * None of them is the switch's own reason — a refusal leaves the switch on — so they read as the
 * sweep's answer rather than as the project's, and each simply disappears when there is nothing to
 * say. A project that isn't left to work says nothing: the task it holds is released with the claim
 * (#270), not here.
 */
function Working({
  task,
  stage,
  stageName,
  refusal,
  manyRepos,
}: {
  task: ProjectIssue | null | undefined
  stage: AfkStage | null | undefined
  /** The stage's own name from the task's snapshot, so a workflow's words show rather than ours. */
  stageName: string | null | undefined
  refusal: string | null | undefined
  manyRepos: boolean
}) {
  if (!task && !refusal) return null
  const label = stageName ?? (stage ? STAGE_LABELS[stage] : null)
  return (
    <div className="flex flex-col gap-3">
      {refusal && (
        <p data-refusal className="px-1 text-sm text-destructive" role="status">
          {refusal}
        </p>
      )}
      {task && (
        <section aria-label="Working" data-working data-stage={stage ?? undefined}>
          <h3 className="px-1 pb-1 text-sm text-muted-foreground">Working</h3>
          <TaskLink task={task} label={label} note={manyRepos ? task.repo : undefined} />
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

/** One issue as the sheet shows it: its number and its title, the stage prefixing the title when it
 * has one, opening it on GitHub, a note under it. */
function TaskLink({
  task,
  label,
  note,
  badge,
}: {
  task: ProjectIssue
  label?: string | null
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
        <span className="shrink-0 font-mono text-base text-muted-foreground">#{task.number}</span>
        <span className="min-w-0 flex-1 text-base leading-snug break-words">
          {label && <span className="text-muted-foreground">{`${label}: `}</span>}
          {task.title}
        </span>
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

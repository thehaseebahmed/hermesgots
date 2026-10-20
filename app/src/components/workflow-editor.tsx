import { useState } from "react"
import { MoreHorizontalIcon, PlusIcon } from "lucide-react"

import { Popup, PopupContent, PopupHeader, PopupTitle } from "@/components/popup"
import { SkillSheet } from "@/components/skill-sheet"
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { Input } from "@/components/ui/input"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import type { Skill } from "@/lib/hermes"
import {
  MAX_CAP,
  MIN_CAP,
  stepOrder,
  validate,
  withShipping,
  type Workflow,
  type WorkflowEntry,
  type WorkflowStage,
} from "@/lib/workflow"

/** A stage nothing has been said about yet. */
function blankStage(name: string): WorkflowStage {
  return { name, steps: [], check: null, loop: null, ships: false }
}

/**
 * A workflow, edited: its name and its stages in order, each stage's skills — picked through the
 * shared skill sheet, so a skill reads the same here as in the composer's menu — its loop and the
 * one stage that ships.
 *
 * The editor asks for the stage list and the skills, and derives the rest: the steps are kept
 * alphabetical, and the shipping mark follows the last stage that runs skills rather than a check.
 * What it saves is what the host would accept, since `validate` speaks the host's own refusals; a
 * preset is saved as a copy, which is the host's rule, not a question here.
 */
export function WorkflowEditor({
  open,
  onOpenChange,
  entry,
  skills,
  skillsLoading,
  onSave,
  onDelete,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  /** The workflow being edited; null for a new one. */
  entry: WorkflowEntry | null
  skills: Skill[]
  skillsLoading: boolean
  /** Writes the workflow, answering whether the host took it; a refusal is thrown as its message. */
  onSave: (workflow: Workflow, id: string | null) => Promise<void>
  /** Removes one of the account's own workflows. Never offered for a preset. */
  onDelete: (entry: WorkflowEntry) => Promise<void>
}) {
  // The draft, seeded from the workflow being edited. The sheet is keyed by what it edits, so a new
  // open starts from the row it names rather than from the last thing typed into it.
  const [name, setName] = useState(entry?.name ?? "")
  const [stages, setStages] = useState<WorkflowStage[]>(() =>
    entry ? entry.stages.map((stage) => ({ ...stage })) : withShipping([blankStage("Build")]),
  )
  const [error, setError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  // The sheet's own place: the stage it is for, and — for a single pick — the step it replaces.
  const [picking, setPicking] = useState<{ stage: number; step?: string } | null>(null)

  const marked = withShipping(stages)

  const change = (index: number, next: Partial<WorkflowStage>) =>
    setStages((held) => held.map((stage, at) => (at === index ? { ...stage, ...next } : stage)))

  const move = (index: number, by: -1 | 1) =>
    setStages((held) => {
      const next = [...held]
      const [stage] = next.splice(index, 1)
      next.splice(index + by, 0, stage)
      return next
    })

  const remove = (index: number) => setStages((held) => held.filter((_, at) => at !== index))

  const add = () => setStages((held) => [...held, blankStage(`Stage ${held.length + 1}`)])

  const picked = (names: string[]) => {
    if (!picking) return
    const stage = stages[picking.stage]
    if (!stage) return
    if (picking.step !== undefined) {
      // One step, swapped for the one picked; a step is one skill, so the first is the answer.
      if (names.length !== 1) return
      const steps = stage.steps.map((step) => (step === picking.step ? names[0] : step))
      change(picking.stage, { steps: stepOrder(steps) })
      return
    }
    change(picking.stage, { steps: stepOrder(names) })
  }

  const submit = async () => {
    const body: Workflow = { name, stages: withShipping(stages) }
    const refusal = validate(body)
    if (refusal) {
      setError(refusal)
      return
    }
    setError(null)
    setSaving(true)
    try {
      await onSave(body, entry?.id ?? null)
      onOpenChange(false)
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : "Couldn't save the workflow.")
    } finally {
      setSaving(false)
    }
  }

  const stage = picking ? stages[picking.stage] : undefined

  return (
    <Popup open={open} onOpenChange={onOpenChange}>
      <PopupContent>
        <PopupHeader className="pb-2">
          <PopupTitle>{entry ? "Edit workflow" : "New workflow"}</PopupTitle>
        </PopupHeader>
        <div className="flex min-h-0 flex-col gap-4 px-4 pb-4 sm:px-6">
          <Input
            aria-label="Workflow name"
            placeholder="Name"
            className="h-11"
            value={name}
            onChange={(event) => setName(event.target.value)}
          />
          <ul className="flex flex-col gap-3" aria-label="Stages">
            {marked.map((one, index) => (
              <li
                key={index}
                data-stage={index}
                className="flex flex-col gap-2 rounded-2xl border p-3"
              >
                <div className="flex items-center gap-2">
                  <Input
                    aria-label={`Stage ${index + 1} name`}
                    className="h-11 min-w-0 flex-1"
                    value={one.name}
                    onChange={(event) => change(index, { name: event.target.value })}
                  />
                  <DropdownMenu>
                    <DropdownMenuTrigger
                      render={
                        <Button
                          type="button"
                          variant="ghost"
                          size="icon"
                          aria-label={`Stage ${index + 1} options`}
                          className="size-11 shrink-0"
                        />
                      }
                    >
                      <MoreHorizontalIcon />
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="end">
                      <DropdownMenuItem
                        className="min-h-11"
                        disabled={index === 0}
                        onClick={() => move(index, -1)}
                      >
                        Move up
                      </DropdownMenuItem>
                      <DropdownMenuItem
                        className="min-h-11"
                        disabled={index === marked.length - 1}
                        onClick={() => move(index, 1)}
                      >
                        Move down
                      </DropdownMenuItem>
                      {one.loop ? (
                        <DropdownMenuItem
                          className="min-h-11"
                          onClick={() => change(index, { loop: null })}
                        >
                          No loop
                        </DropdownMenuItem>
                      ) : (
                        index > 0 && (
                          <DropdownMenuItem
                            className="min-h-11"
                            onClick={() =>
                              change(index, { loop: { from: marked[index - 1].name, cap: 3 } })
                            }
                          >
                            Repeat from {marked[index - 1].name}
                          </DropdownMenuItem>
                        )
                      )}
                      <DropdownMenuSeparator />
                      <DropdownMenuItem
                        className="min-h-11"
                        disabled={marked.length === 1}
                        onClick={() => remove(index)}
                      >
                        Remove stage
                      </DropdownMenuItem>
                    </DropdownMenuContent>
                  </DropdownMenu>
                </div>
                <div className="flex flex-wrap items-center gap-2">
                  {one.steps.map((step) => (
                    <button
                      key={step}
                      type="button"
                      onClick={() => setPicking({ stage: index, step })}
                      aria-label={`Change ${step}`}
                      className="min-h-11 rounded-full bg-muted px-3 font-mono text-sm outline-none hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring"
                    >
                      {step}
                    </button>
                  ))}
                  <Button
                    type="button"
                    variant="ghost"
                    aria-label={`Steps for stage ${index + 1}`}
                    className="h-11 min-w-11"
                    onClick={() => setPicking({ stage: index })}
                  >
                    <PlusIcon />
                    <span className="text-sm">Steps</span>
                  </Button>
                </div>
                {one.loop && (
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="text-sm text-muted-foreground">Repeat from</span>
                    <Select
                      value={one.loop.from}
                      items={marked.slice(0, index).map((other) => ({
                        value: other.name,
                        label: other.name,
                      }))}
                      onValueChange={(value) =>
                        change(index, { loop: { from: String(value), cap: one.loop!.cap } })
                      }
                    >
                      <SelectTrigger
                        aria-label={`Stage ${index + 1} repeats from`}
                        className="h-11 w-40"
                      >
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {marked.slice(0, index).map((other) => (
                          <SelectItem key={other.name} value={other.name}>
                            {other.name}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                    <Input
                      type="number"
                      inputMode="numeric"
                      aria-label={`Stage ${index + 1} rounds`}
                      className="h-11 w-20"
                      min={MIN_CAP}
                      max={MAX_CAP}
                      value={one.loop.cap}
                      onChange={(event) =>
                        change(index, {
                          loop: { from: one.loop!.from, cap: Number(event.target.value) },
                        })
                      }
                    />
                    <span className="text-sm text-muted-foreground">rounds</span>
                  </div>
                )}
                <div className="flex flex-wrap items-center gap-2">
                  {one.check === "gate" && <Badge variant="outline">Gate</Badge>}
                  {/* Derived, not chosen: the last stage that runs skills is the one that ships. */}
                  {one.ships && <Badge variant="secondary">Ships</Badge>}
                </div>
              </li>
            ))}
          </ul>
          <Button type="button" variant="secondary" className="h-11" onClick={add}>
            Add stage
          </Button>
          {error && (
            <p role="alert" className="px-1 text-sm text-destructive">
              {error}
            </p>
          )}
          <div className="flex items-center justify-between gap-2 pt-1">
            {entry && !entry.preset ? (
              <AlertDialog>
                <AlertDialogTrigger
                  render={<Button type="button" variant="ghost" disabled={saving} />}
                >
                  Delete
                </AlertDialogTrigger>
                <AlertDialogContent>
                  <AlertDialogHeader>
                    <AlertDialogTitle>Delete this workflow?</AlertDialogTitle>
                    <AlertDialogDescription>
                      {entry.name} is removed from the library.
                    </AlertDialogDescription>
                  </AlertDialogHeader>
                  <AlertDialogFooter>
                    <AlertDialogCancel render={<Button type="button" variant="ghost" />}>
                      Cancel
                    </AlertDialogCancel>
                    <AlertDialogAction
                      render={<Button type="button" variant="destructive" />}
                      onClick={() => void onDelete(entry)}
                    >
                      Delete
                    </AlertDialogAction>
                  </AlertDialogFooter>
                </AlertDialogContent>
              </AlertDialog>
            ) : (
              <span className="px-1 text-sm text-muted-foreground">
                {entry ? "Saving makes a copy." : ""}
              </span>
            )}
            <Button type="button" className="h-11" disabled={saving} onClick={() => void submit()}>
              {entry && !entry.preset ? "Save" : "Create"}
            </Button>
          </div>
        </div>
        <SkillSheet
          open={picking !== null}
          onOpenChange={(next) => !next && setPicking(null)}
          title={
            picking?.step ? `Change ${picking.step}` : `Steps for ${stage?.name ?? "the stage"}`
          }
          skills={skills}
          loading={skillsLoading}
          multiple={picking?.step === undefined}
          value={picking?.step ? [picking.step] : (stage?.steps ?? [])}
          onChoose={picked}
        />
      </PopupContent>
    </Popup>
  )
}

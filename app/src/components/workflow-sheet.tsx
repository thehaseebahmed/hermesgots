import { CheckIcon, PencilIcon } from "lucide-react"

import { Popup, PopupContent, PopupHeader, PopupTitle } from "@/components/popup"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Spinner } from "@/components/ui/spinner"
import { workflowShape, type WorkflowEntry } from "@/lib/workflow"

/**
 * The workflows a bot's account keeps: presets first, read-only, and the ones the account wrote.
 * Picking a row puts the project's work under it — one write — and the pencil opens the editor, which
 * forks a preset into a copy rather than rewriting it.
 *
 * Each row names the workflow's shape, so the sheet says what the work would do, not just what someone
 * called it.
 */
export function WorkflowSheet({
  open,
  onOpenChange,
  entries,
  error,
  chosenId,
  saving,
  onPick,
  onEdit,
  onNew,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  /** The library as the host answered it, or undefined before the first read lands. */
  entries: WorkflowEntry[] | undefined
  error: string | undefined
  /** The workflow the project's work runs under, so the sheet opens on the choice it holds. */
  chosenId: string | undefined
  saving: boolean
  onPick: (entry: WorkflowEntry) => void
  onEdit: (entry: WorkflowEntry) => void
  onNew: () => void
}) {
  // Presets first, each group as the host listed it: the library's own order is its own.
  const ordered = entries
    ? [...entries.filter((one) => one.preset), ...entries.filter((one) => !one.preset)]
    : undefined
  return (
    <Popup open={open} onOpenChange={onOpenChange}>
      <PopupContent>
        <PopupHeader className="pb-2">
          <PopupTitle>Workflow</PopupTitle>
        </PopupHeader>
        <div className="flex min-h-0 flex-col gap-3 px-4 pb-4 sm:px-6">
          {error ? (
            <p className="px-1 text-sm text-destructive">{error}</p>
          ) : !ordered ? (
            <p className="flex items-center gap-2 px-1 py-2 text-sm text-muted-foreground">
              <Spinner className="size-4" /> Reading workflows…
            </p>
          ) : ordered.length === 0 ? (
            <p className="px-1 py-2 text-sm text-muted-foreground">No workflows yet.</p>
          ) : (
            <ul aria-label="Workflows">
              {ordered.map((entry) => {
                const chosen = entry.id === chosenId
                return (
                  <li key={entry.id} className="flex items-center gap-1" data-workflow={entry.id}>
                    <button
                      type="button"
                      aria-current={chosen}
                      disabled={saving}
                      onClick={() => onPick(entry)}
                      className="flex min-h-11 min-w-0 flex-1 flex-col justify-center gap-0.5 rounded-2xl px-3 py-2 text-left outline-none hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring"
                    >
                      <span className="flex min-w-0 items-center gap-2">
                        {chosen && <CheckIcon aria-hidden className="size-4 shrink-0" />}
                        <span className="min-w-0 truncate text-base">{entry.name}</span>
                        {entry.preset && (
                          <Badge variant="secondary" className="shrink-0">
                            Preset
                          </Badge>
                        )}
                      </span>
                      <span className="min-w-0 truncate pl-6 text-sm text-muted-foreground">
                        {workflowShape(entry.stages)}
                      </span>
                    </button>
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon"
                      aria-label={`Edit ${entry.name}`}
                      className="size-11 shrink-0"
                      onClick={() => onEdit(entry)}
                    >
                      <PencilIcon />
                    </Button>
                  </li>
                )
              })}
            </ul>
          )}
          <Button type="button" variant="secondary" className="h-11" onClick={onNew}>
            New workflow
          </Button>
        </div>
      </PopupContent>
    </Popup>
  )
}

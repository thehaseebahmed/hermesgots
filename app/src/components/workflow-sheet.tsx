import { CheckIcon } from "lucide-react"

import { Popup, PopupContent, PopupHeader, PopupTitle } from "@/components/popup"
import { SheetPickerList, SheetPickerRow } from "@/components/sheet-picker"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { workflowShape, type WorkflowEntry } from "@/lib/workflow"

/**
 * The workflows a bot's account keeps: presets first, read-only, and the ones the account wrote.
 * Picking a row puts the project's work under it — one write — and the pencil opens the editor, which
 * forks a preset into a copy rather than rewriting it.
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
          <SheetPickerList
            entries={ordered}
            error={error}
            label="Workflows"
            reading="Reading workflows…"
            empty="No workflows yet."
            row={(entry) => {
              const chosen = entry.id === chosenId
              return (
                <SheetPickerRow
                  key={entry.id}
                  attribute="data-workflow"
                  id={entry.id}
                  name={entry.name}
                  chosen={chosen}
                  saving={saving}
                  onPick={() => onPick(entry)}
                  onEdit={() => onEdit(entry)}
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
                </SheetPickerRow>
              )
            }}
          />
          <Button type="button" variant="secondary" className="h-11" onClick={onNew}>
            New workflow
          </Button>
        </div>
      </PopupContent>
    </Popup>
  )
}

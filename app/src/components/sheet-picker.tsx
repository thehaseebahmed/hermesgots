/**
 * The row a library sheet offers, and the list around it: one record's name and its own second
 * line, the pencil that opens it, and the reading and empty lines a list shows before it has rows.
 * Both sheets that pick something — the workflows a bot's account keeps and the account's Prompts —
 * are this row, so a record looks and behaves the same wherever it is offered, and a spinner or an
 * empty line is fixed once rather than once per sheet.
 *
 * The caller owns the list and what a pick means: these draw a row, report the pointer, and say what
 * a list with nothing in it is called.
 */
import type { ReactNode } from "react"
import { PencilIcon } from "lucide-react"

import { Button } from "@/components/ui/button"
import { Spinner } from "@/components/ui/spinner"

/**
 * One record in a picker: a full-width button carrying what the sheet reads of it, and the pencil
 * that opens it to be renamed, rewritten or deleted. `chosen` marks the record the screen holds
 * already — the check inside the row and `aria-current` on the control — and is left out where a
 * list has nothing chosen, so the attribute's absence means the same in both sheets.
 */
export function SheetPickerRow({
  id,
  attribute,
  name,
  chosen,
  saving = false,
  pickLabel,
  onPick,
  onEdit,
  children,
}: {
  /** The record's id, which the row's own `data-` attribute carries for a test or a flow to read. */
  id: string
  /** The attribute naming the kind of record, `data-workflow` or `data-prompt`. */
  attribute: `data-${string}`
  /** The record's name, which is what its pencil is called: `Edit <name>`. */
  name: string
  /** Whether this is the record the screen holds now: checked, and read as `aria-current`. */
  chosen?: boolean
  /** A write is on its way: the row is out of reach until its answer lands. */
  saving?: boolean
  /** The pick button's own name, where the record's name alone would read as nothing to press. */
  pickLabel?: string
  onPick: () => void
  onEdit: () => void
  /** What the row reads: the name line, its badges and the line under them. */
  children: ReactNode
}) {
  return (
    <li className="flex items-center gap-1" {...{ [attribute]: id }}>
      <button
        type="button"
        aria-label={pickLabel}
        aria-current={chosen}
        disabled={saving}
        onClick={onPick}
        className="flex min-h-11 min-w-0 flex-1 flex-col justify-center gap-0.5 rounded-2xl px-3 py-2 text-left outline-none hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring"
      >
        {children}
      </button>
      <Button
        type="button"
        variant="ghost"
        size="icon"
        aria-label={`Edit ${name}`}
        className="size-11 shrink-0"
        onClick={onEdit}
      >
        <PencilIcon />
      </Button>
    </li>
  )
}

/**
 * The list itself: the error a read answered, the line it reads while the first answer is on its
 * way, the line an empty library says, and the rows. `row` is the caller's own `SheetPickerRow`, so
 * each sheet keeps what it reads of a record and shares everything around it.
 */
export function SheetPickerList<T>({
  entries,
  error,
  label,
  reading,
  empty,
  row,
}: {
  /** The records as the sheet holds them; undefined until the first read lands. */
  entries: T[] | undefined
  /** Why the read failed, where it did: the list says so instead of reading forever. */
  error?: string
  /** The list's accessible name — what these records are. */
  label: string
  /** What the list reads while it waits for the first answer, "Reading workflows…". */
  reading: string
  /** What a list with nothing in it says. */
  empty: string
  row: (entry: T) => ReactNode
}) {
  if (error) return <p className="px-1 text-sm text-destructive">{error}</p>
  if (!entries) {
    return (
      <p className="flex items-center gap-2 px-1 py-2 text-sm text-muted-foreground">
        <Spinner className="size-4" /> {reading}
      </p>
    )
  }
  if (entries.length === 0) {
    return <p className="px-1 py-2 text-sm text-muted-foreground">{empty}</p>
  }
  return <ul aria-label={label}>{entries.map((entry) => row(entry))}</ul>
}

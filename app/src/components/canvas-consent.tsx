/**
 * A canvas's own record and its tools (ADR 0114, issue #933): the options the header's ellipsis
 * opens — the canvas's name, whether it is pinned to the sidebar, whether it is archived out of the list,
 * and the one way to delete it — and, under them, the reader's answers about the tools this version
 * declared. Every change but a tool's is the canvas's record on the host, so the same page is named,
 * pinned and archived the same way on every device; nothing here is kept on this one alone.
 */
import { useCallback, useState } from "react"
import { Trash2Icon } from "lucide-react"

import { Popup, PopupContent, PopupHeader, PopupTitle } from "@/components/popup"
import {
  ConfirmDestructive,
  FormActions,
  Group,
  RowText,
  SwitchRow,
  fieldInputClass,
  fieldLabelClass,
  linkRowClass,
} from "@/components/settings-chrome"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
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
import type { Canvas, CanvasChanges } from "@/lib/canvases"
import { cn } from "@/lib/utils"

/** The plugin's own cap on a canvas's title (`canvases.py`'s `TITLE_CHARS`), mirrored by the field. */
const TITLE_CHARS = 60

/** One tool waiting for an answer, and the two ways the call held on it can settle. */
export interface ConsentAsk {
  tool: string
  /** The page's answer: what the reader chose, and what the host said to it. */
  resolve: (allow: boolean) => void
  /** The host's own refusal of the grant — a version rewritten while the dialog was up — which is
   * neither the reader's yes nor their no. */
  fail: (error: unknown) => void
}

/**
 * The ask on screen, and where it stands among the ones still waiting: the queue's own index, so a
 * batch reads 1 of 2 and the question that follows it is counted afresh.
 */
export interface ShownAsk extends ConsentAsk {
  position: number
}

/**
 * The asks a page's tool calls are waiting on, one shown at a time. `ask` never settles until the
 * reader answers; `answer` hands the tool to `onAnswer`, which posts the grant, and resolves the
 * page's promise with what that write settled on — Allow true, Don't allow false. A write the host
 * refused rejects it with the host's own failure, so the page is never told the reader said no.
 */
export function useCanvasConsent(onAnswer: (tool: string, allow: boolean) => Promise<boolean>) {
  const [queue, setQueue] = useState<ConsentAsk[]>([])

  const ask = useCallback(
    (tool: string) =>
      new Promise<boolean>((resolve, reject) => {
        setQueue((waiting) => [...waiting, { tool, resolve, fail: reject }])
      }),
    [],
  )

  const answer = useCallback(
    async (allow: boolean) => {
      const current = queue[0]
      if (!current) return
      try {
        current.resolve(await onAnswer(current.tool, allow))
      } catch (error) {
        current.fail(error)
      } finally {
        // Out of the queue however the write went: a page waiting on a dialog that has gone would
        // wait for ever, and the next ask draws at once rather than behind an answered one.
        setQueue((waiting) => waiting.filter((one) => one !== current))
      }
    },
    [queue, onAnswer],
  )

  // Counted from the queue itself, never from the place an ask took when it arrived: a question
  // answered long ago must not leave the next one reading 3 of 3. One waiting is no count at all.
  const head = queue[0]
  const current = head ? { ...head, position: queue.indexOf(head) + 1 } : null
  return { current, total: queue.length, ask, answer }
}

/**
 * The question a page's tool call waits on: an Android-style centred dialog naming the canvas and
 * the tool, Allow or Don't allow, and — while more than one tool waits — which ask this is.
 *
 * Don't allow is the dialog's own dismissal rather than a button's handler: the cancel button, Escape
 * and a tap outside are one path, so one press can only ever answer once.
 */
export function CanvasConsentDialog({
  canvasTitle,
  ask,
  total,
  onAnswer,
}: {
  canvasTitle: string
  ask: ShownAsk | null
  total: number
  onAnswer: (allow: boolean) => void
}) {
  if (!ask) return null
  return (
    <AlertDialog
      open
      onOpenChange={(open) => {
        if (!open) onAnswer(false)
      }}
    >
      <AlertDialogContent size="sm" data-canvas-consent>
        <AlertDialogHeader>
          <AlertDialogTitle>
            Allow {canvasTitle} to use {ask.tool}?
          </AlertDialogTitle>
          {total > 1 && (
            <AlertDialogDescription>
              {ask.position} of {total}
            </AlertDialogDescription>
          )}
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel data-consent="deny">Don't allow</AlertDialogCancel>
          <AlertDialogAction data-consent="allow" onClick={() => onAnswer(true)}>
            Allow
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}

/**
 * A canvas's name, edited on its own surface: a field and the app's Cancel/Save bar. A text value is
 * never edited beside instant switches, and nothing is written until Save (settings-ux).
 */
function NameSheet({
  open,
  onOpenChange,
  title,
  onSave,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  title: string
  onSave: (title: string) => Promise<void>
}) {
  const [name, setName] = useState(title)
  const [saving, setSaving] = useState(false)
  // The host writes one line: whitespace folded, then its cap. The field holds what a Save would
  // write, so what is typed and what lands agree.
  const trimmed = name.trim().replace(/\s+/g, " ")
  const canSave = trimmed.length > 0 && trimmed !== title

  const save = async () => {
    if (!canSave || saving) return
    setSaving(true)
    try {
      await onSave(trimmed)
      onOpenChange(false)
    } catch {
      // Said where it was read; the field keeps the words so the next Save is a retry.
    } finally {
      setSaving(false)
    }
  }

  return (
    <Popup open={open} onOpenChange={onOpenChange}>
      <PopupContent>
        <PopupHeader>
          <PopupTitle>Name</PopupTitle>
        </PopupHeader>
        <form
          className="flex flex-col gap-4 px-4 pb-4"
          onSubmit={(event) => {
            event.preventDefault()
            void save()
          }}
        >
          <div className="flex flex-col gap-2">
            <label htmlFor="canvas-name" className={fieldLabelClass}>
              Name
            </label>
            <Input
              id="canvas-name"
              value={name}
              autoComplete="off"
              maxLength={TITLE_CHARS}
              onChange={(event) => setName(event.target.value)}
              className={fieldInputClass}
            />
          </div>
          <FormActions onCancel={() => onOpenChange(false)} disabled={!canSave} busy={saving} />
        </form>
      </PopupContent>
    </Popup>
  )
}

/**
 * A canvas's options: the record's place and the answers its version carries, changed after the fact.
 *
 * Placement is a name row that opens its own sheet — a text value is edited with Cancel and Save —
 * then Pin and Hide, which write the moment they are flipped. Under them, one row per tool of the
 * union: every tool this version declares, and every tool the host holds an answer for that this
 * version no longer declares, which is still the reader's to revoke. Last is Delete, which asks
 * first, since it takes the page, its data and its chat with it.
 *
 * Every control is disabled while one of the sheet's writes is out, so a second tap can't be lost:
 * two answers for one canvas would land in either order, and a switch that moves under a tap is no
 * switch.
 */
export function CanvasOptions({
  open,
  onOpenChange,
  canvas,
  onGrant,
  onUpdate,
  onDelete,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  canvas: Canvas | undefined
  onGrant: (tool: string, allow: boolean) => Promise<boolean>
  /** Writes the canvas's own record; the host's answer is what the screens redraw from. */
  onUpdate: (changes: CanvasChanges) => Promise<void>
  /** Removes the canvas and everything on the host that went with it. */
  onDelete: () => Promise<void>
}) {
  const [saving, setSaving] = useState<string | null>(null)
  const [asking, setAsking] = useState(false)
  const [naming, setNaming] = useState(false)
  const busy = saving !== null
  const deleting = saving === "delete"

  const declared = canvas?.tools ?? []
  const held = canvas?.grants ?? []
  const rows = [
    ...declared.map((tool) => ({ tool, declared: true })),
    ...held
      .filter((row) => !declared.includes(row.tool))
      .map((row) => ({ tool: row.tool, declared: false })),
  ]

  const change = async (key: string, write: () => Promise<void>) => {
    if (busy) return
    setSaving(key)
    try {
      await write()
    } catch {
      // The refusal was said where it was read; the row redraws from the record the host holds.
    } finally {
      setSaving(null)
    }
  }

  const remove = async () => {
    if (busy) return
    setSaving("delete")
    try {
      await onDelete()
    } catch {
      // Still there, so the question stays up and a retry is one tap.
      return
    } finally {
      setSaving(null)
    }
    setAsking(false)
  }

  return (
    <>
      <Popup open={open} onOpenChange={onOpenChange}>
        <PopupContent>
          <PopupHeader>
            <PopupTitle>Options</PopupTitle>
          </PopupHeader>
          <div data-canvas-options className="flex flex-col gap-4 px-4 pb-4">
            <Group>
              <button
                type="button"
                className={cn(linkRowClass, "disabled:opacity-60")}
                disabled={!canvas || busy}
                onClick={() => setNaming(true)}
              >
                <RowText title="Name" />
                <span className="max-w-[50%] truncate text-sm text-muted-foreground">
                  {canvas?.title}
                </span>
              </button>
            </Group>

            <Group>
              <SwitchRow
                id="canvas-pinned"
                title="Pin to sidebar"
                subtitle="Keep it in the sidebar under the app's own screens, on every device."
                checked={canvas?.pinned === true}
                disabled={!canvas || busy}
                onCheckedChange={(checked) =>
                  void change("pinned", () => onUpdate({ pinned: checked }))
                }
              />
              <SwitchRow
                id="canvas-archived"
                title="Archive"
                subtitle="Keep it out of the Canvas list without deleting it."
                checked={canvas?.archived === true}
                disabled={!canvas || busy}
                onCheckedChange={(checked) =>
                  void change("archived", () => onUpdate({ archived: checked }))
                }
              />
            </Group>

            {rows.length === 0 ? (
              <p className="py-2 text-sm text-muted-foreground">
                This version doesn't call any of the bot's tools.
              </p>
            ) : (
              <Group>
                {rows.map(({ tool, declared: current }) => {
                  const answer = held.find((row) => row.tool === tool)?.allowed
                  return (
                    <SwitchRow
                      key={tool}
                      id={`canvas-tool-${tool}`}
                      title={tool}
                      data-canvas-tool={tool}
                      subtitle={
                        !current
                          ? "Not declared by this version"
                          : answer === true
                            ? "Allowed"
                            : answer === false
                              ? "Not allowed"
                              : "Not asked yet"
                      }
                      checked={answer === true}
                      disabled={busy}
                      onCheckedChange={(checked) =>
                        void change(tool, () => onGrant(tool, checked).then(() => undefined))
                      }
                    />
                  )
                })}
              </Group>
            )}

            <Group>
              <Button
                type="button"
                variant="ghost"
                className="h-11 w-full justify-start rounded-full text-destructive"
                disabled={!canvas || busy}
                onClick={() => setAsking(true)}
              >
                <Trash2Icon data-icon="inline-start" />
                Delete canvas
              </Button>
            </Group>
          </div>
        </PopupContent>
      </Popup>

      {canvas && (
        <NameSheet
          key={canvas.title}
          open={naming}
          onOpenChange={setNaming}
          title={canvas.title}
          onSave={(title) => onUpdate({ title })}
        />
      )}

      <ConfirmDestructive
        open={asking}
        title={`Delete ${canvas?.title ?? "this canvas"}?`}
        description="Its page, its data and its chat go with it. This can't be undone."
        confirmLabel="Delete"
        cancelLabel="Keep it"
        busy={deleting}
        onOpenChange={setAsking}
        onConfirm={() => void remove()}
      />
    </>
  )
}

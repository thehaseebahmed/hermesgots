/**
 * A canvas's own record and its tools (ADR 0114, issue #933): the options the canvas's header opens —
 * the canvas's name, whether it is pinned to the sidebar, whether it is archived out of the list, and
 * the one way to delete it; and, under them, the reader's answers about the tools this version
 * declared. Every change but a tool's is the canvas's record on the host, so the same page is named,
 * pinned and archived the same way on every device; nothing here is kept on this one alone.
 */
import { useCallback, useEffect, useRef, useState } from "react"

import { Popup, PopupContent, PopupHeader, PopupTitle } from "@/components/popup"
import { CanvasMark } from "@/components/canvas-mark"
import { CanvasMarkPicker } from "@/components/canvas-mark-picker"
import { ConfirmDestructive } from "@/components/confirm-destructive"
import {
  DestructiveButton,
  Group,
  SwitchRow,
} from "@/components/settings-chrome"
import { Button } from "@/components/ui/button"
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
 * A canvas's options: the record's place and the answers its version carries, changed after the fact.
 *
 * The name is the sheet's own first row — a field and a Save, the way a project's Edit screen draws
 * its name — since a text value is never written as it is typed, and nothing is sent until the Save
 * beside it. Under it, Pin, Archive and, where the host keeps a vault, Back up to a wiki, which write
 * the moment they are flipped. Under them, one row per tool of the union: every tool this version
 * declares, and every tool the host holds an answer for that this version no longer declares, which
 * is still the reader's to revoke. Last is Delete — the app's one destructive shape
 * (`DestructiveButton`), under the last group rather than inside a card of its own, and it asks
 * first, since it takes the page, its data and its chat with it.
 *
 * The backup row is drawn only where the host advertises `canvas_vault` (`vaultable`): a plugin from
 * before it has no writer, and a switch that writes nothing is a promise the host can't keep. The
 * mark row is drawn on the same rule (`markable`), since its picker writes a field an older record
 * has no room for.
 *
 * Every control is disabled while one of the sheet's writes is out, so a second tap can't be lost:
 * two answers for one canvas would land in either order, and a switch that moves under a tap is no
 * switch.
 */
export function CanvasOptions({
  open,
  onOpenChange,
  canvas,
  vaultable,
  markable,
  onGrant,
  onUpdate,
  onDelete,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  canvas: Canvas | undefined
  /** Whether this bot's host keeps a vault, which is what offers the backup switch. */
  vaultable: boolean
  /** Whether this bot's host keeps a mark on the record, which is what offers the mark row. */
  markable: boolean
  onGrant: (tool: string, allow: boolean) => Promise<boolean>
  /** Writes the canvas's own record; the host's answer is what the screens redraw from. */
  onUpdate: (changes: CanvasChanges) => Promise<void>
  /** Removes the canvas and everything on the host that went with it. */
  onDelete: () => Promise<void>
}) {
  const [saving, setSaving] = useState<string | null>(null)
  const [asking, setAsking] = useState(false)
  const [marking, setMarking] = useState(false)
  // The mark's own box in the name block: the picker opens anchored to it, so a laptop draws the
  // card beside it (the model selector's rule) and a phone draws a sheet.
  const markButton = useRef<HTMLButtonElement>(null)
  // The name's field, focused when the sheet opens: the sheet is the screen the reader came to for
  // the name, and its first row is the field.
  const nameField = useRef<HTMLInputElement>(null)
  const busy = saving !== null
  const deleting = saving === "delete"
  // The name as the field holds it, and the record's title it was typed against: while they agree the
  // field shows the words, and a record the host answers moves the title past them, so the field
  // draws the record again — what is typed and what lands are the same one line.
  const title = canvas?.title ?? ""
  const [draft, setDraft] = useState<{ against: string; name: string } | null>(null)
  const name = draft?.against === title ? draft.name : title
  // The host writes one line: whitespace folded, then its cap. The field's ink is what a Save would
  // send, so a name left as it was — or one of nothing but spaces — is no write at all.
  const trimmed = name.trim().replace(/\s+/g, " ")
  const renaming = trimmed.length > 0 && trimmed !== title

  useEffect(() => {
    if (!open) return
    // After the pop-up's own commit: its content mounts on open, so the field is here a frame later.
    const frame = requestAnimationFrame(() => nameField.current?.focus())
    return () => cancelAnimationFrame(frame)
  }, [open])

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
    } finally {
      setSaving(null)
    }
    setAsking(false)
  }

  /** The name's own write: the one control here that waits for a press rather than a flip. */
  const saveName = () => {
    if (!renaming || busy) return
    void change("name", () => onUpdate({ title: trimmed }))
  }

  return (
    <>
      <Popup open={open} onOpenChange={onOpenChange}>
        <PopupContent>
          <PopupHeader>
            <PopupTitle>Options</PopupTitle>
          </PopupHeader>
          <div data-canvas-options className="flex flex-col gap-4 px-4 pb-4">
            {/* The mark and the name in one row, the way a project's Edit screen draws its own: the
                box at the head is the mark, and a tap on it picks another (issue #1065); the name is
                typed here and written by the Save that appears once it differs from the record. */}
            <section data-canvas-name-block className="flex flex-col gap-2">
              <label htmlFor="canvas-name" className="px-1 text-sm font-medium">
                Name
              </label>
              <div className="flex items-center gap-3 rounded-3xl bg-muted p-2">
                <button
                  ref={markButton}
                  type="button"
                  data-canvas-mark-open
                  aria-label={markable ? "Change mark" : "Mark"}
                  disabled={!canvas || busy || !markable}
                  onClick={() => setMarking(true)}
                  className="flex size-12 shrink-0 items-center justify-center rounded-2xl bg-background/60 outline-none transition-colors hover:bg-background focus-visible:ring-2 focus-visible:ring-ring/50 disabled:opacity-60"
                >
                  <CanvasMark mark={canvas?.mark} />
                </button>
                <input
                  ref={nameField}
                  id="canvas-name"
                  autoComplete="off"
                  maxLength={TITLE_CHARS}
                  value={name}
                  disabled={!canvas || busy}
                  onChange={(event) => setDraft({ against: title, name: event.target.value })}
                  onKeyDown={(event) => {
                    // Enter is the Save, from the field itself: a phone's keyboard has no room for a
                    // second press, and the write is the same one.
                    if (event.key !== "Enter") return
                    event.preventDefault()
                    saveName()
                  }}
                  className="h-11 min-w-0 flex-1 bg-transparent pr-3 text-base outline-none disabled:opacity-60"
                />
                {renaming && (
                  <Button
                    type="button"
                    size="sm"
                    data-canvas-name-save
                    className="mr-1 shrink-0 rounded-full"
                    disabled={busy}
                    onClick={saveName}
                  >
                    Save
                  </Button>
                )}
              </div>
            </section>

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
              {vaultable && (
                <SwitchRow
                  id="canvas-vault"
                  title="Back up to a wiki"
                  subtitle="Copy its data into a markdown vault on this bot's host, kept up to date while it's on."
                  checked={canvas?.vault === true}
                  disabled={!canvas || busy}
                  onCheckedChange={(checked) => void change("vault", () => onUpdate({ vault: checked }))}
                />
              )}
            </Group>

            {/* Nothing where a version declares no tools and holds no grant: an empty card's fill
                reads as a gap, which is the same noise as a sentence apologising for it. */}
            {rows.length > 0 && (
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

            <DestructiveButton disabled={!canvas || busy} onClick={() => setAsking(true)}>
              Delete canvas
            </DestructiveButton>
          </div>
        </PopupContent>
      </Popup>

      {canvas && (
        <CanvasMarkPicker
          key={canvas.id}
          open={marking}
          onOpenChange={setMarking}
          anchor={markButton}
          canvas={canvas}
          onUpdate={onUpdate}
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
        // The promise is the write's own: a refusal then keeps the question up with the host's
        // words in it, rather than closing over a canvas that is still there.
        onConfirm={remove}
      />
    </>
  )
}

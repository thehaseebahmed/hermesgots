/**
 * A canvas's tools and the reader's answers (ADR 0114): the ask a page's tool call waits on, and the
 * options that list what this version declared so an answer can be changed later. The page never
 * reads either — the bridge holds its call until the dialog answers — so this is only the surface.
 */
import { useCallback, useState } from "react"

import { Popup, PopupContent, PopupHeader, PopupTitle } from "@/components/popup"
import { Group, SwitchRow } from "@/components/settings-chrome"
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
import type { Canvas } from "@/lib/canvases"

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
 * The answers a canvas's version carries, changed after the fact: one row per tool of the union —
 * every tool this version declares, and every tool the host holds an answer for that this version no
 * longer declares, which is still the reader's to revoke. Its Switch is on where the user allowed it,
 * and a line says which of not asked, not allowed or undeclared the off state is.
 *
 * The row is the Settings switch row, so the switch is named by the row's own label — the tool and
 * its state — rather than by an aria-label no other switch in the app wears.
 */
export function CanvasOptions({
  open,
  onOpenChange,
  canvas,
  onGrant,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  canvas: Canvas | undefined
  onGrant: (tool: string, allow: boolean) => Promise<boolean>
}) {
  const [saving, setSaving] = useState<string | null>(null)
  const declared = canvas?.tools ?? []
  const held = canvas?.grants ?? []
  const rows = [
    ...declared.map((tool) => ({ tool, declared: true })),
    ...held
      .filter((row) => !declared.includes(row.tool))
      .map((row) => ({ tool: row.tool, declared: false })),
  ]

  const change = async (tool: string, allow: boolean) => {
    setSaving(tool)
    try {
      await onGrant(tool, allow)
    } catch {
      // A refusal the host answered with was said where it was read, and the switch goes back to
      // what the host holds: a grant that never landed is not an answer this sheet keeps.
    } finally {
      setSaving(null)
    }
  }

  return (
    <Popup open={open} onOpenChange={onOpenChange}>
      <PopupContent>
        <PopupHeader>
          <PopupTitle>Options</PopupTitle>
        </PopupHeader>
        <div data-canvas-options className="px-4 pb-4">
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
                    disabled={saving === tool}
                    onCheckedChange={(checked) => void change(tool, checked)}
                  />
                )
              })}
            </Group>
          )}
        </div>
      </PopupContent>
    </Popup>
  )
}

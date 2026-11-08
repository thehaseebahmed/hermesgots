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

/** One tool waiting for an answer, where it stands among the asks, and the call held on it. */
export interface ConsentAsk {
  tool: string
  position: number
  resolve: (allow: boolean) => void
}

/**
 * The asks a page's tool calls are waiting on, one shown at a time. `ask` never settles until the
 * reader answers; `answer` hands the tool to `onAnswer`, which posts the grant, and resolves the
 * page's promise with what that write settled on — Allow true, Don't allow false.
 */
export function useCanvasConsent(onAnswer: (tool: string, allow: boolean) => Promise<boolean>) {
  const [queue, setQueue] = useState<ConsentAsk[]>([])

  const ask = useCallback(
    (tool: string) =>
      new Promise<boolean>((resolve) => {
        setQueue((waiting) => [
          ...waiting,
          // Where this ask stands: one more than the last waiting one, so a batch of questions
          // reads 1 of 2 and then 2 of 2 rather than starting over as each is answered.
          {
            tool,
            position: waiting.reduce((last, one) => Math.max(last, one.position), 0) + 1,
            resolve,
          },
        ])
      }),
    [],
  )

  const answer = useCallback(
    async (allow: boolean) => {
      const current = queue[0]
      if (!current) return
      // Out of the queue before the write is asked for, so the dialog is gone and the next ask draws
      // at once rather than the reader answering a question that is still on screen.
      setQueue((waiting) => waiting.filter((one) => one !== current))
      let answered = false
      try {
        answered = await onAnswer(current.tool, allow)
      } catch {
        // A write that threw is no answer to tell the page yes to, and the promise has to settle
        // either way: a page waiting on a dialog that has gone would wait for ever.
        answered = false
      }
      current.resolve(answered)
    },
    [queue, onAnswer],
  )

  const total = queue.reduce((last, one) => Math.max(last, one.position), 0)
  return { current: queue[0] ?? null, total, ask, answer }
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
  ask: ConsentAsk | null
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
 * The answers a canvas's version carries, changed after the fact: one row per declared tool, its
 * Switch on where the user allowed it, and a line saying which of not asked and not allowed the off
 * state is. A tool the host never answered for reads as not asked.
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
  const tools = canvas?.tools ?? []

  const change = async (tool: string, allow: boolean) => {
    setSaving(tool)
    try {
      await onGrant(tool, allow)
    } finally {
      setSaving(null)
    }
  }

  return (
    <Popup open={open} onOpenChange={onOpenChange}>
      <PopupContent>
        <PopupHeader>
          <PopupTitle>{canvas?.title ?? "Canvas"} options</PopupTitle>
        </PopupHeader>
        <div data-canvas-options className="px-4 pb-4">
          {tools.length === 0 ? (
            <p className="py-2 text-sm text-muted-foreground">
              This version doesn't call any of the bot's tools.
            </p>
          ) : (
            <Group>
              {tools.map((tool) => {
                const answer = (canvas?.grants ?? []).find((row) => row.tool === tool)?.allowed
                return (
                  <SwitchRow
                    key={tool}
                    id={`canvas-tool-${tool}`}
                    title={tool}
                    subtitle={
                      answer === true
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

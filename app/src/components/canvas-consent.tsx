/**
 * A canvas's tools and the reader's answers (ADR 0114): the ask a page's tool call waits on, and the
 * options that list what this version declared so an answer can be changed later. The page never
 * reads either — the bridge holds its call until the dialog answers — so this is only the surface.
 */
import { useCallback, useRef, useState } from "react"

import { Popup, PopupContent, PopupHeader, PopupTitle } from "@/components/popup"
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
import { Switch } from "@/components/ui/switch"
import type { Canvas } from "@/lib/canvases"

/** One tool waiting for an answer, where it stands among the asks, and the call held on it. */
export interface ConsentAsk {
  tool: string
  position: number
  resolve: (allow: boolean) => void
}

/**
 * The asks a page's tool calls are waiting on, one shown at a time, for a canvas with this title.
 * `ask` never settles until the reader answers; `answer` hands the tool to `onAnswer`, which posts
 * the grant, and resolves with what the host's write settled on — Allow true, Don't allow false.
 */
export function useCanvasConsent(
  canvasTitle: string,
  onAnswer: (tool: string, allow: boolean) => Promise<boolean>,
) {
  const [queue, setQueue] = useState<ConsentAsk[]>([])
  // A dialog dismissed by Escape answers Don't allow as the Cancel button does: one press must not
  // resolve the same ask twice, since the grant write and the page's retry both hang off it.
  const answering = useRef(false)

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
      if (answering.current || !current) return
      answering.current = true
      try {
        current.resolve(await onAnswer(current.tool, allow))
        setQueue((waiting) => waiting.filter((one) => one !== current))
      } finally {
        answering.current = false
      }
    },
    [queue, onAnswer],
  )

  const total = queue.reduce((last, one) => Math.max(last, one.position), 0)
  return {
    canvasTitle,
    current: queue[0] ?? null,
    position: queue[0]?.position ?? 1,
    total,
    ask,
    answer,
  }
}

/**
 * The question a page's tool call waits on: an Android-style centred dialog naming the canvas and
 * the tool, Allow or Don't allow, and — while more than one tool waits — which ask this is.
 */
export function CanvasConsentDialog({
  canvasTitle,
  ask,
  position,
  total,
  onAnswer,
}: {
  canvasTitle: string
  ask: ConsentAsk | null
  position: number
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
              {position} of {total}
            </AlertDialogDescription>
          )}
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel data-consent="deny" onClick={() => onAnswer(false)}>
            Don't allow
          </AlertDialogCancel>
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
        <div data-canvas-options className="flex flex-col gap-1 px-4 pb-4">
          {tools.length === 0 ? (
            <p className="py-2 text-sm text-muted-foreground">
              This version doesn't call any of the bot's tools.
            </p>
          ) : (
            tools.map((tool) => {
              const answer = (canvas?.grants ?? []).find((row) => row.tool === tool)?.allowed
              return (
                <div key={tool} className="flex min-h-11 items-center gap-3">
                  <span className="flex min-w-0 flex-1 flex-col">
                    <span className="truncate text-sm">{tool}</span>
                    <span className="text-xs text-muted-foreground">
                      {answer === true
                        ? "Allowed"
                        : answer === false
                          ? "Not allowed"
                          : "Not asked yet"}
                    </span>
                  </span>
                  <Switch
                    aria-label={`Allow ${tool}`}
                    checked={answer === true}
                    disabled={saving === tool}
                    onCheckedChange={(checked) => void change(tool, checked)}
                  />
                </div>
              )
            })
          )}
        </div>
      </PopupContent>
    </Popup>
  )
}

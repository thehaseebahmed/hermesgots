import { useCallback, useId, useRef, useState } from "react"

import { usePreviewer, type PreviewItem } from "@/components/chat/previewer"
import { openAttachment, openFailed } from "@/lib/attachments"
import type { HermesConfig } from "@/lib/hermes"
import { drawnCell, mediaKind } from "@/lib/media-kind"
import { folderItems, previewItem } from "@/lib/media-items"
import { askMediaUrl, askNote, heldMediaUrl } from "@/lib/media-url"

/** A file a screen lists rather than one a thread was sent: where it lies, and what to call it. */
export interface HostFile {
  name: string
  path: string
}

/** What a screen's tap on one of its files asks for: open it, and which one is still being asked for. */
export interface HostFileOpen {
  /**
   * Opens a file among the files it is listed with, so the Previewer holds the whole list and the
   * reader steps through it. A screen with nothing to step to passes the one file, at `0`.
   */
  open: (files: HostFile[], at: number) => void
  /** The path being opened right now, so its row alone can say it is working. */
  busy: string | null
}

/**
 * Opens a file the host holds by the rule ADR 0071 wrote, for a screen that isn't a thread — a
 * library's tree, and whatever lists files next: a photo, a clip, a recording or a page opens in the
 * app's own **Previewer**, from a URL the bot signs for the file (a page drawn in its sandboxed frame,
 * ADR 0134), and anything the Previewer can't draw — a note, an archive, a photo no browser decodes —
 * is handed to the platform, which shows it or saves it under its own name. `drawnCell` is that rule
 * and `openAttachment` is the hand-over, so neither is written twice here.
 *
 * The file tapped is signed first, because that is what decides the hand-over, and only then is the
 * list built: the Previewer opens on the folder's files in the order the screen draws them, at the one
 * tapped, with every other file unsigned until the reader steps onto it. A file the name left out of
 * that list — the screen listed it beside ones the Previewer draws — opens alone, exactly as a screen
 * with no siblings always has.
 *
 * The answer is kept whole rather than as a URL or nothing: a file too large for the route says so in
 * its own sentence, and a host that didn't answer is not a missing file.
 */
export function useOpenHostFile(config: HermesConfig): HostFileOpen {
  const { open: preview, update } = usePreviewer()
  const owner = useId()
  const [busy, setBusy] = useState<string | null>(null)
  // The list the Previewer is drawing, kept here because a step fills one of its files after it was
  // opened: a step writes the whole list back through the provider's own `update`.
  const drawing = useRef<PreviewItem[]>([])
  /** Signs one file of the open list and writes the list back with what answered. */
  const sign = useCallback(
    (item: PreviewItem, again: boolean) => {
      void (async () => {
        const answer = await askMediaUrl(config, item.key, { again })
        drawing.current = drawing.current.map((one) => {
          if (one.key !== item.key) return one
          // The host's own words for the ways it answers without a URL: a file it hasn't got, one it
          // refused in the route's own sentence, a plugin too old to sign, a host that didn't reply.
          if (answer.state !== "ready")
            return { ...one, state: "failed", note: askNote(answer, one.name) }
          return {
            ...one,
            type: answer.read.type,
            size: answer.read.size ?? one.size,
            src: answer.read.url,
            folder: answer.read.folder,
            state: "ready",
          }
        })
        update(owner, drawing.current)
      })()
    },
    [config, owner, update],
  )

  const open = useCallback(
    (files: HostFile[], at: number) => {
      const file = files[at]
      if (!file) return
      // A URL this page already holds opens at once, so the row isn't dimmed for a round trip it
      // never makes.
      const held = heldMediaUrl(config, file.path)
      if (!held) setBusy(file.path)
      void (async () => {
        try {
          const answer = await askMediaUrl(config, file.path, { again: !held })
          if (answer.state !== "ready") throw new Error(askNote(answer, file.name))
          const read = answer.read
          const cell = drawnCell(read.type, file.name)
          if (cell === "file") {
            // The host names the file in how it serves it, so the platform both shows a note and
            // saves an archive under the name it has.
            await openAttachment(null, { name: file.name, type: read.type, src: read.url })
            return
          }
          // The tapped file as the host answered for it.
          const item = previewItem({
            key: file.path,
            kind: mediaKind(read.type, file.name),
            cell,
            name: file.name,
            type: read.type,
            size: read.size,
            path: file.path,
            src: read.url,
            folder: read.folder,
            state: "ready",
          })
          const list = folderItems(files, at)
          if (list.index < 0) {
            drawing.current = [item]
            preview(
              {
                items: [item],
                index: 0,
                onShown: (one) => sign(one, false),
                onRetry: (one) => sign(one, true),
                onElsewhere: (one) => void openAttachment(null, one),
              },
              owner,
            )
            return
          }
          drawing.current = list.items.map((one, place) => (place === list.index ? item : one))
          // Under this opener's own name, which is what lets an answer for one of the folder's files
          // land on the list that is open rather than on one a screen has closed.
          preview(
            {
              items: drawing.current,
              index: list.index,
              // A file the reader steps onto is signed as it arrives.
              onShown: (one) => sign(one, false),
              onRetry: (one) => sign(one, true),
              onElsewhere: (one) => void openAttachment(null, one),
            },
            owner,
          )
        } catch (error) {
          openFailed(file.name, error)
        } finally {
          setBusy(null)
        }
      })()
    },
    [config, owner, preview, sign],
  )
  return { open, busy }
}

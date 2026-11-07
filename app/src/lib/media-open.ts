import { useCallback, useState } from "react"

import { usePreviewer } from "@/components/chat/previewer"
import { openAttachment, openFailed } from "@/lib/attachments"
import type { HermesConfig } from "@/lib/hermes"
import { drawnCell, mediaKind } from "@/lib/media-kind"
import { previewItem } from "@/lib/media-items"
import { askMediaUrl, askNote, heldMediaUrl } from "@/lib/media-url"

/** A file a screen lists rather than one a thread was sent: where it lies, and what to call it. */
export interface HostFile {
  name: string
  path: string
}

/** What a screen's tap on one of its files asks for: open it, and whether it is still being asked for. */
export interface HostFileOpen {
  open: (file: HostFile) => void
  /** Whether this file is being opened right now, so its row can say it is working. */
  busy: boolean
}

/**
 * Opens a file the host holds by the rule ADR 0071 wrote, for a screen that isn't a thread — a
 * library's tree, and whatever lists files next: a photo, a clip or a recording opens in the app's
 * own **Previewer**, from a URL the bot signs for the file, and anything the Previewer can't draw — a
 * note, a page, an archive, a photo no browser decodes — is handed to the platform, which shows it or
 * saves it under its own name. `drawnCell` is that rule and `openAttachment` is the hand-over, so
 * neither is written twice here.
 *
 * The answer is kept whole rather than as a URL or nothing: a file too large for the route says so in
 * its own sentence, and a host that didn't answer is not a missing file.
 */
export function useOpenHostFile(config: HermesConfig): HostFileOpen {
  const { open: preview } = usePreviewer()
  const [busy, setBusy] = useState(false)
  const open = useCallback(
    (file: HostFile) => {
      // A URL this page already holds opens at once, so the row isn't dimmed for a round trip it
      // never makes.
      const held = heldMediaUrl(config, file.path)
      if (!held) setBusy(true)
      void (async () => {
        try {
          const answer = await askMediaUrl(config, file.path, { again: !held })
          if (answer.state !== "ready") throw new Error(askNote(answer, file.name))
          const read = answer.read
          const cell = drawnCell(read.type, file.name)
          if (cell === "file") {
            // The host names the file in how it serves it, so the platform both shows a page or a
            // note and saves an archive under the name it has.
            await openAttachment(null, { name: file.name, type: read.type, src: read.url })
            return
          }
          preview({
            items: [
              previewItem({
                key: file.path,
                kind: mediaKind(read.type, file.name),
                cell,
                name: file.name,
                type: read.type,
                size: read.size,
                path: file.path,
                src: read.url,
                state: "ready",
              }),
            ],
            index: 0,
          })
        } catch (error) {
          openFailed(file.name, error)
        } finally {
          setBusy(false)
        }
      })()
    },
    [config, preview],
  )
  return { open, busy }
}

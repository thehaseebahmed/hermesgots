/**
 * A request, as a send writes it and as every reader takes it apart: the user's words, then the
 * marker lines the composer's picks added — a point per element of a canvas's page, a mention per
 * session or bot the reader tagged — and last the files, which the send path appends on its way out.
 *
 * The order is one rule in one place because it is invisible at every site it matters: a reader
 * that peels these blocks in any other order stops on the block underneath, and the marker line a
 * model was meant to read is handed to a screen as if the user had typed it. Two readers had already
 * drifted apart that way — the current screen's user row, and the row it queues — which is what this
 * module exists to stop happening again.
 *
 * Import-free but for the marker modules and the attachment one, all pure, so the unit tier loads
 * this file under `node --experimental-strip-types`.
 */
import type { Attachment } from "./db.ts"
import { attachmentsText, splitAttachments } from "./attachment-text.ts"
import { mentionText, mentionsIn, type Mention } from "./mention-marker.ts"
import { pointText, pointsIn, type CanvasPoint } from "./point-marker.ts"
import { requestIn } from "./retry-message.ts"

/** What the composer holds when it sends: the reader's words and the picks that ride with them. */
export interface Request {
  text: string
  points?: CanvasPoint[]
  mentions?: Mention[]
}

/**
 * The message the host is handed: the words, the point lines, the mention lines, and then the files.
 * The files go last because the send path appends them; a caller that carries none passes none.
 */
export function markRequest(request: Request, attachments: Attachment[] = []): string {
  const { text, points = [], mentions = [] } = request
  return attachmentsText(mentionText(pointText(text, points), mentions), attachments)
}

/** One request, read back off the text the host stores. */
export interface ReadRequest {
  /** The reader's own words, with every marker block taken off. */
  text: string
  attachments: Attachment[]
  points: CanvasPoint[]
  mentions: Mention[]
  /** Whether this row is the app re-asking an earlier request rather than something a person sent. */
  retry: boolean
}

/**
 * The request a row holds, peeled in the reverse of the order `markRequest` writes it: the files
 * (which the send path appended last), then the mentions, then the points — each block taken from
 * its own end.
 */
export function readRequest(content: string): ReadRequest {
  const request = requestIn(content)
  const { text: plain, attachments } = splitAttachments(request)
  const { text: withoutMentions, mentions } = mentionsIn(plain)
  const { text, points } = pointsIn(withoutMentions)
  return { text, attachments, points, mentions, retry: request !== content }
}

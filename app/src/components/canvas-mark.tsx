/**
 * The mark at the head of a canvas's row (issue #1065): the icon or emoji its user chose for it,
 * drawn on the canvas's own record so every device's sidebar shows the same one.
 *
 * A canvas nobody has marked draws the app's frame mark — what every canvas's row drew before a mark
 * could be chosen, and the same markup still, so an unmarked canvas's row is unchanged.
 */
import { FrameIcon } from "lucide-react"

/** The row's own head: one 20px slot, whatever draws in it. */
export function CanvasMark() {
  return <FrameIcon className="size-5 text-muted-foreground" />
}

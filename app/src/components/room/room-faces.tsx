import { Bot } from "@/components/bot"
import { cn } from "@/lib/utils"

/**
 * A room's row, drawn as its members: up to four of their bots' pictures, overlapped by 8px so the
 * cluster reads as one thing, and a count for the members it could not show (ADR 0126).
 *
 * The overlap is the whole trick: each picture's own transparency is what separates it from the one
 * under it, so the cluster needs no ring or backing disc — the app draws bots as their art everywhere
 * else, and a circle behind a character that is not round would be a second shape to explain.
 *
 * `label` is the members' names, and with it the cluster is one named picture rather than decoration:
 * a room's line says what was last said in it, so the names a screen reader used to hear there now
 * ride the mark, as a single `role="img"` and never a list of unlabelled images. Without a label it
 * stays hidden from a screen reader, which is the little a rail's one face has to say.
 */
export function RoomFaces({
  shown,
  more,
  label,
  collapsed = false,
  className,
}: {
  /** The bots to draw, in the order the Host seats them. Only the first four are ever handed over. */
  shown: string[]
  /** How many members the row could not draw a picture for. */
  more: number
  /** The members' names, for the reader who cannot see the pictures: the cluster becomes one image. */
  label?: string
  /** A rail draws no room for a cluster: it shows the member a room is most likely to answer as. */
  collapsed?: boolean
  className?: string
}) {
  if (!shown.length && !more) return null
  if (collapsed) return <Bot id={shown[0]} className={cn("size-5", className)} />
  return (
    <span
      {...(label ? { role: "img", "aria-label": label } : { "aria-hidden": true })}
      data-room-faces
      className={cn("flex shrink-0 items-center", className)}
    >
      {shown.map((id, at) => (
        // The first face sits above the ones it overlaps, so the cluster reads left to right.
        <span
          key={`${id}-${at}`}
          className={cn("relative flex shrink-0", at > 0 && "-ml-2")}
          style={{ zIndex: shown.length - at }}
        >
          <Bot id={id} className="size-5" />
        </span>
      ))}
      {more > 0 && (
        <span
          data-room-faces-more
          className="relative -ml-2 flex size-5 items-center justify-center rounded-full bg-muted text-[10px] leading-none font-semibold text-muted-foreground tabular-nums"
          style={{ zIndex: 0 }}
        >
          +{more}
        </span>
      )}
    </span>
  )
}

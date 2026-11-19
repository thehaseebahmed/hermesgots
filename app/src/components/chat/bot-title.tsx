import { Link } from "react-router"

import { Bot } from "@/components/bot"
import { botPath } from "@/lib/bot-tabs"

/**
 * A list bar's title when the list speaks for the bot itself: its face and the name lists call it, as
 * the press onto its settings page — the way Main's own bar leads there. The flat layout's list wears
 * it, and so does the Side Chat List where it stands beside Main.
 */
export function BotTitle({ botId, face, label }: { botId: string; face: string; label: string }) {
  return (
    <Link
      to={botPath(botId)}
      className="-ml-2 flex min-h-11 min-w-0 items-center gap-2 rounded-full px-2 outline-none hover:bg-muted/60 focus-visible:ring-2 focus-visible:ring-ring"
    >
      <span aria-hidden className="shrink-0">
        <Bot id={face} className="size-9" />
      </span>
      <span className="truncate">{label}</span>
    </Link>
  )
}

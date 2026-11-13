/**
 * The `@` menu: this bot's sessions and the other bots on its host, one row each, drawn in the same
 * box the `/` menu hangs in.
 *
 * A row's name is what a pick writes into the sentence, so `@` is part of what the row shows; the
 * line under it says which kind of thing it is, because two names can read alike. The list is one
 * group and one `optionId` run, so a row's id means the same thing whichever kind it holds.
 */
import { useEffect } from "react"
import { BotIcon, MessageCircleIcon, type LucideIcon } from "lucide-react"

import { MenuBox } from "@/components/chat/menu-box"
import { PickGroup, PickRow } from "@/components/pick-row"
import { Spinner } from "@/components/ui/spinner"
import type { MentionRow } from "@/lib/mentions"
import type { MentionKind } from "@/lib/mention-marker"
import { optionId } from "@/lib/slash"

const KIND_ICONS: Record<MentionKind, LucideIcon> = {
  // A circle, not a rounded square: at 16px the square reads as a checkbox the row isn't.
  session: MessageCircleIcon,
  bot: BotIcon,
}

export function MentionMenu({
  id,
  rows,
  active,
  status,
  onPick,
  onActive,
}: {
  id: string
  rows: MentionRow[]
  active: number
  status: "ok" | "loading"
  onPick: (row: MentionRow) => void
  onActive: (index: number) => void
}) {
  // The list scrolls inside the room it was given, so the row the arrows walk to has to follow.
  useEffect(() => {
    document.getElementById(optionId(id, active))?.scrollIntoView({ block: "nearest" })
  }, [id, active])

  // Nothing to offer and nothing being read: no box at all, rather than an empty one over the field.
  if (!rows.length && status === "ok") return null

  return (
    <MenuBox>
      {(room) => (
        <>
          <PickGroup
            mode="option"
            label="Sessions and bots"
            id={id}
            style={{ maxHeight: room }}
            className="overflow-y-auto p-1.5"
          >
            {rows.map((row, index) => {
              const Icon = KIND_ICONS[row.kind]
              return (
                <PickRow
                  key={`${row.kind}:${row.id}`}
                  id={optionId(id, index)}
                  leading={<Icon className="size-4 text-muted-foreground" />}
                  title={<span className="min-w-0 truncate text-sm">@{row.name}</span>}
                  line={row.line}
                  active={index === active}
                  onActive={() => index !== active && onActive(index)}
                  onPick={() => onPick(row)}
                />
              )
            })}
          </PickGroup>
          {status === "loading" && (
            <div className="flex items-center gap-2 border-t px-4 py-2.5 text-xs text-muted-foreground">
              <Spinner className="size-3.5" /> Loading…
            </div>
          )}
        </>
      )}
    </MenuBox>
  )
}

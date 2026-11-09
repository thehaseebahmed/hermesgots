import { useState } from "react"
import { EllipsisIcon, PencilIcon, Trash2Icon } from "lucide-react"

import { ConfirmDialog } from "@/components/chat/confirm-dialog"
import { RenameDialog } from "@/components/chat/rename-dialog"
import { Button } from "@/components/ui/button"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import type { Profile } from "@/lib/db"
import { usePluginFeatureOn } from "@/lib/features"
import { disbandRoomNow, renameRoomTo } from "@/lib/rooms"

/**
 * A room's own menu, in its header: Rename and Disband, and nothing of a chat's (ADR 0122). The chat's
 * `ChatActions` edits a chat's title edit, its resolve state and its model, none of which a room has —
 * its name is the Host's and its work is the Host's — so the two menus are two menus.
 *
 * Nothing is drawn where the bot that answers for the room cannot write one: a control that can only
 * come back refused is worse than no control. Both writes answer the room's own record, so the row the
 * screen is drawn from is the row the Host's answer leaves (ADR 0123), and a refusal stands where it
 * was asked in the Host's own words.
 */
export function RoomActions({
  roomId,
  name,
  answerer,
}: {
  roomId: string
  /** The room's name as the screen draws it, which the rename dialog opens with. */
  name: string
  /** The bot that answers for the room: the write goes through it, and its Host is the gate. */
  answerer?: Profile
}) {
  const canWrite = usePluginFeatureOn(answerer, "rooms_write")
  const [renaming, setRenaming] = useState(false)
  const [disbanding, setDisbanding] = useState(false)
  const [pending, setPending] = useState(false)
  if (!canWrite || !answerer) return null
  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger
          render={
            <Button
              variant="outline"
              size="icon-lg"
              className="pointer-events-auto size-11 rounded-full bg-background/80 backdrop-blur"
              aria-label="Room options"
            />
          }
        >
          <EllipsisIcon />
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="min-w-44">
          <DropdownMenuItem onClick={() => setRenaming(true)}>
            <PencilIcon />
            Rename
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem variant="destructive" onClick={() => setDisbanding(true)}>
            <Trash2Icon />
            Disband
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>

      <RenameDialog
        open={renaming}
        onOpenChange={setRenaming}
        title="Rename room"
        fieldLabel="Room name"
        value={name}
        onSave={(next) => renameRoomTo(answerer, roomId, next)}
      />

      <ConfirmDialog
        open={disbanding}
        onOpenChange={setDisbanding}
        title="Disband this room?"
        description="Its work stops, and the room is gone for every device. This can't be undone."
        confirm="Disband"
        pending={pending}
        onConfirm={async () => {
          setPending(true)
          try {
            await disbandRoomNow(answerer, roomId)
          } finally {
            setPending(false)
          }
        }}
      />
    </>
  )
}

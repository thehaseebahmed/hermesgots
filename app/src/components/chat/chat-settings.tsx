import { useState } from "react"
import { ArchiveIcon, BellOffIcon, PinIcon } from "lucide-react"

import { ConfirmDestructive } from "@/components/confirm-destructive"
import { Popup, PopupContent, PopupHeader, PopupTitle } from "@/components/popup"
import {
  DestructiveButton,
  Group,
  SwitchRow,
  fieldInnerClass,
  fieldLabelClass,
} from "@/components/settings-chrome"
import { Button } from "@/components/ui/button"
import { InputGroup, InputGroupInput } from "@/components/ui/input-group"
import { mayArchive, pinSwitchOf } from "@/lib/chat-list"
import { setArchived, setPinned, usePinsInList } from "@/lib/chat-marks"
import {
  deleteConversation,
  updateConversation,
  type Conversation,
  type Profile,
} from "@/lib/db"
import { usePluginFeatureOn } from "@/lib/features"
import { useLegacyChat } from "@/lib/legacy-chat"
import { setThreadMuted } from "@/lib/push"
import { disbandRoomNow, renameRoomTo } from "@/lib/room-writes"
import { stopMessage } from "@/lib/chat"
import { randomId } from "@/lib/utils"

/**
 * A chat's bar's title as the press that opens its settings (ADR 0153): the header's `onTitlePress`
 * answers the whole block, and this button is what a reader, a tab stop and a keyboard press, its
 * own clicks bubbling to that block.
 */
export function ChatTitlePress({ title, open }: { title: string; open: boolean }) {
  return (
    <button
      type="button"
      aria-haspopup="dialog"
      aria-expanded={open}
      data-chat-settings-open
      className="flex min-h-11 w-full min-w-0 items-center text-left outline-none"
    >
      <span className="min-w-0 truncate">{title}</span>
    </button>
  )
}

/**
 * The sheet's pin row, and the only surface that reads the list's pins: `usePinsInList` mounts a
 * second `useRoomNeeds` — every room's row, and a read of its Host's log for each of them — so it is
 * read here, where a sheet that is shut unmounts it. What it answers decides whether a switch is drawn
 * at all and whether it may be turned: both rules are `pinSwitchOf`'s, this row and its line included.
 */
function PinRow({ chat, profileId }: { chat: Conversation; profileId: string }) {
  const pins = usePinsInList(profileId)
  const pin = pinSwitchOf(chat, pins)
  if (!pin.offered) return null
  return (
    <SwitchRow
      id="chat-pin"
      data-chat-pin
      icon={PinIcon}
      title="Pin"
      subtitle={pin.subtitle}
      checked={pin.checked}
      disabled={pin.disabled}
      onCheckedChange={(checked) => void setPinned(chat.id, checked)}
    />
  )
}

/**
 * A conversation's own settings, from the press its bar's title answers.
 *
 * A bar carries no `…` and no way to its bot's list — the list is where a conversation is reached
 * from, and back is how it is left (ADR 0153). What the menus that stood there held is this sheet, as
 * the rows the app's settings screens are drawn with: the name typed where it is shown, the mute and
 * the pin as the switches of one card, the archive as the outline above the delete, and the delete as
 * the same confirmation the menu opened, asked in the same words.
 *
 * What is being edited is read off the record it is handed rather than off scalar props beside it. A
 * **room** is its Host's: its name and its disband are the Host's own writes, offered only
 * where the Host advertises `rooms_write`, and each carries an id minted once per opening of its
 * question, so a retry after a dropped answer is the same rename and the same stop (ADR 0123). Its pin
 * and its archive are still the reader's own marks, drawn on any Host. A **run** keeps the name and the
 * mute a chat has, and a chat keeps everything else. A project session keeps its `…`, whose resolve,
 * discard and delete are not a chat's settings, and the bot's own mute and delete stay on its settings
 * page.
 */
export function ChatSettings({
  chat,
  profileId,
  answerer,
  open,
  onOpenChange,
  onDeleted,
}: {
  chat: Conversation
  /**
   * The bot's list the pin cap is counted over: the profile this chat is a row of, defaulting to the
   * one the record names. A room lists in every bot its roster seats, so a screen that opened the
   * room from one bot's list passes that bot's (`chat-marks.ts`).
   */
  profileId?: string
  /**
   * The bot that answers for a room: its writes go through it, and its Host is the gate. A chat and a
   * run write to this device and name none.
   */
  answerer?: Profile
  open: boolean
  onOpenChange: (open: boolean) => void
  /**
   * Where to go once a chat or a run is gone. A room names none: its row going is what leaves, and the
   * screen that holds it already steps off a room it no longer holds (`room-chat.tsx`).
   */
  onDeleted?: () => void
}) {
  const room = Boolean(chat.room)
  // A room's writes are its Host's, and a control that can only come back refused is worse than none.
  const canWrite = usePluginFeatureOn(answerer, "rooms_write")
  const roomHost = room && canWrite && answerer ? answerer : undefined
  const [deleting, setDeleting] = useState(false)
  const [disbanding, setDisbanding] = useState(false)
  // One id per opening of each question: a name saved again after a dropped answer is the same
  // rename, and a Disband the same stop, which is the whole of what makes a retry safe (ADR 0123).
  // A question is opened by the sheet it is asked in, so both are let go when that closes and the
  // next opening asks its own.
  const [renameId, setRenameId] = useState("")
  const [cancelId, setCancelId] = useState("")
  const setSheetOpen = (next: boolean) => {
    if (!next) {
      setRenameId("")
      setCancelId("")
      // An edit abandoned here is not a field that stands refused for good.
      setTyped(undefined)
      setRefusal(undefined)
    }
    onOpenChange(next)
  }
  // The Archived pill is the only place a row is set aside *from*, and the legacy bands hold none:
  // archiving is offered only where that pill is. The way back is offered everywhere — an archive that
  // arrived by merge is in no band on this layout, and a row nothing could bring back is a trap.
  const archivesHere = useLegacyChat() === false
  // The field holds what is being typed, and the record what was last written: an edit abandoned or
  // refused leaves the name as it was, and the Host's words stand under the field that asked for it.
  const [typed, setTyped] = useState<string>()
  const name = typed ?? chat.title
  const [refusal, setRefusal] = useState<string>()
  const saveName = async () => {
    const next = name.trim()
    if (!next || next === chat.title) {
      setTyped(undefined)
      setRefusal(undefined)
      return
    }
    if (!roomHost) {
      await updateConversation(chat.id, { title: next, titleEdited: true })
      return
    }
    const id = renameId || randomId()
    if (!renameId) setRenameId(id)
    try {
      await renameRoomTo(roomHost, chat.id, next, id)
      setRefusal(undefined)
      // A name the Host took is done with: the next save in this opening asks under an id of its own,
      // since the same id carrying a different name is a replay to a Host that keys on it (ADR 0123).
      setRenameId("")
    } catch (error) {
      setRefusal(error instanceof Error && error.message ? error.message : "That didn't save.")
    }
  }

  return (
    <>
      <Popup open={open} onOpenChange={setSheetOpen}>
        {/* The field is the sheet's first control, and a phone opens its keyboard for whichever
            control takes the focus — over a sheet the reader only just opened. */}
        <PopupContent initialFocus={false}>
          <PopupHeader className="pb-2">
            <PopupTitle>{room ? "Edit room" : "Edit chat"}</PopupTitle>
          </PopupHeader>
          <div className="flex flex-col gap-6 px-4 pb-4 sm:px-6">
            {/* A room's name is its Host's, so the field waits for a Host that can write one; a chat's
                and a run's are this device's own row. */}
            {(!room || roomHost) && (
              <div className="flex flex-col gap-2">
                <label htmlFor="chat-name" className={fieldLabelClass}>
                  Name
                </label>
                <InputGroup className="h-12 rounded-full bg-muted">
                  <InputGroupInput
                    id="chat-name"
                    data-chat-name
                    className={fieldInnerClass}
                    autoComplete="off"
                    autoCapitalize="off"
                    autoCorrect="off"
                    spellCheck={false}
                    value={name}
                    onChange={(event) => {
                      setTyped(event.target.value)
                      // The words were about the name that was refused: another one is a new ask.
                      setRefusal(undefined)
                    }}
                    onBlur={() => void saveName()}
                    onKeyDown={(event) => {
                      if (event.key === "Enter") event.currentTarget.blur()
                    }}
                  />
                </InputGroup>
                {refusal && (
                  <p role="alert" className="px-1 text-sm text-destructive">
                    {refusal}
                  </p>
                )}
              </div>
            )}
            <Group>
              {/* A room has no mute: it runs no model call of its own, so nothing pushes for it. */}
              {!room && (
                <SwitchRow
                  id="chat-muted"
                  icon={BellOffIcon}
                  title="Mute notifications"
                  subtitle="Every push from this chat"
                  checked={Boolean(chat.muted)}
                  onCheckedChange={(checked) => void setThreadMuted(chat.id, checked)}
                />
              )}
              {/* The pin row is a component of its own, so the reads behind its cap are mounted with
                  the sheet and shut with it: a conversation screen would otherwise read every room's
                  row and its Host's log for a count nobody asked for. */}
              {open && <PinRow chat={chat} profileId={profileId ?? chat.profileId} />}
            </Group>
            <div className="flex flex-col gap-2">
              {(archivesHere || chat.archived) && mayArchive(chat) && (
                <Button
                  type="button"
                  variant="outline"
                  data-chat-archive
                  className="h-11 rounded-full"
                  onClick={() => void setArchived(chat.id, !chat.archived)}
                >
                  <ArchiveIcon data-icon="inline-start" />
                  {chat.archived ? "Unarchive" : "Archive"}
                </Button>
              )}
              {/* A room is disbanded, never deleted: its row going is the Host's own deletion. */}
              {room && roomHost && (
                <DestructiveButton
                  onClick={() => {
                    setCancelId(randomId())
                    setDisbanding(true)
                  }}
                >
                  Disband room
                </DestructiveButton>
              )}
              {!room && !chat.main && (
                <DestructiveButton onClick={() => setDeleting(true)}>Delete chat</DestructiveButton>
              )}
            </div>
          </div>
        </PopupContent>
      </Popup>

      {room && roomHost && (
        <ConfirmDestructive
          open={disbanding}
          onOpenChange={setDisbanding}
          title="Disband this room?"
          description="Its work stops, and the room is gone for every device. This can't be undone."
          confirmLabel="Disband"
          onConfirm={() => disbandRoomNow(roomHost, chat.id, cancelId)}
        />
      )}

      {!room && (
        <ConfirmDestructive
          open={deleting}
          onOpenChange={setDeleting}
          title="Delete this chat?"
          description="It's removed from this device. Hermes keeps its own copy of the session."
          confirmLabel="Delete"
          onConfirm={async () => {
            stopMessage(chat.id)
            await deleteConversation(chat.id)
            onDeleted?.()
          }}
        />
      )}
    </>
  )
}

import { useEffect, useRef, useState } from "react"
import {
  ArchiveIcon,
  ArchiveXIcon,
  BellOffIcon,
  CheckIcon,
  GitForkIcon,
  PinIcon,
  RotateCcwIcon,
} from "lucide-react"

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
import { deleteConversation, updateConversation, type Conversation, type Profile } from "@/lib/db"
import { usePluginFeatureOn } from "@/lib/features"
import { setThreadMuted } from "@/lib/push"
import { disbandRoomNow, renameRoomTo } from "@/lib/room-writes"
import { stopMessage } from "@/lib/chat"
import { quietly } from "@/lib/report"
import { closeSessionWork } from "@/lib/workspace"
import { randomId } from "@/lib/utils"

const CLOSE_WORDS =
  "Its run stops and the host closes the session's work now: its worktrees are removed, unless one has uncommitted or unpushed changes, and its pull request is closed and its branch deleted on GitHub."

/**
 * A chat's bar's title as the press that opens its settings (ADR 0153): the header's `onTitlePress`
 * answers the whole block, and this button is what a reader, a tab stop and a keyboard press, its
 * own clicks bubbling to that block.
 */
export function ChatTitlePress({
  title,
  open,
  centered = false,
}: {
  title: string
  open: boolean
  /** A session's bar is centred, so its title is too. */
  centered?: boolean
}) {
  return (
    <button
      type="button"
      aria-haspopup="dialog"
      aria-expanded={open}
      data-chat-settings-open
      className={
        centered
          ? "flex w-full min-w-0 items-center justify-center outline-none"
          : "flex w-full min-w-0 items-center text-left outline-none"
      }
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
 *
 * The cap is also held by the writer (`setPinned` counts the list before it writes), which answers
 * whether the mark was made. A refused write is what the switch cannot see — a room is drawn in every
 * list that seats it, and one of them can be full while this one is not — so the row says so under its
 * own title, in the sheet's voice, and the count it was read against decides the next press.
 */
function PinRow({ chat, profileId }: { chat: Conversation; profileId: string }) {
  const pins = usePinsInList(profileId)
  const pin = pinSwitchOf(chat, pins)
  const [refused, setRefused] = useState(false)
  if (!pin.offered) return null
  return (
    <SwitchRow
      id="chat-pin"
      data-chat-pin
      icon={PinIcon}
      title="Pin"
      subtitle={pin.subtitle}
      extra={
        refused ? (
          <span role="alert" data-chat-pin-refused className="text-sm text-destructive">
            {chat.room
              ? "Not pinned — one of the lists this room is in already holds five."
              : "Not pinned — this list already holds five."}
          </span>
        ) : undefined
      }
      checked={pin.checked}
      disabled={pin.disabled}
      onCheckedChange={(checked) => {
        void setPinned(chat.id, checked).then((written) => setRefused(!written))
      }}
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
 * mute a chat has, and a chat keeps everything else. A bot's **Main** keeps its mute alone: its title is
 * the Host's, its place is permanent, and nothing on any surface renames, pins, archives or deletes it
 * (G2). A project session is edited here too, on `code`: the repositories it works in,
 * and its own resolve, discard and delete beside the name, mute and pin; it is never archived, since
 * discarding is its way of being put away. The bot's own mute and delete stay on its settings page.
 */
export function ChatSettings({
  chat,
  profileId,
  answerer,
  open,
  onOpenChange,
  onDeleted,
  onArchived,
  code,
}: {
  chat: Conversation
  /**
   * What a project session adds to the sheet: the bot it works as (the host that closes its work),
   * every repository it works in. Its context stays in the bar's ring. Absent for a chat.
   */
  code?: {
    profile: Profile
    repos: readonly string[]
  }
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
  /**
   * Where to go once a chat, a room or a run is archived. An archive is a way out of the
   * conversation, so once the write has answered the screen takes the step back onto the bot's
   * list — the move the bar's back control answers with (ADR 0154) — and the sheet goes with the
   * screen. An unarchive names none: a row coming back is a reason to stay, so the sheet stands.
   */
  onArchived?: () => void
}) {
  const room = Boolean(chat.room)
  // A bot's Main is the host's record with the host's title: it may not be renamed, pinned, archived or
  // deleted from any surface (G2), so the sheet opens with none of those on it. Its mute stays — what a
  // reader says about Main's notifications is still theirs.
  const main = Boolean(chat.main)
  // A room's writes are its Host's, and a control that can only come back refused is worse than none.
  const canWrite = usePluginFeatureOn(answerer, "rooms_write")
  const roomHost = room && canWrite && answerer ? answerer : undefined
  const [deleting, setDeleting] = useState(false)
  const [discarding, setDiscarding] = useState(false)
  const [disbanding, setDisbanding] = useState(false)
  /** Whether this sheet's Archive has been pressed, while the sheet stands through its exit. */
  const pressed = useRef(false)
  // A sheet opened again asks its own question: the latch held the exit window, not the record.
  useEffect(() => {
    if (open) pressed.current = false
  }, [open])
  /** Asks the host to close the session, and moves on: the close runs there (ADR 0080). */
  const closeSession = () => {
    if (!code) return
    stopMessage(chat.id)
    void closeSessionWork(chat, code.profile).catch(quietly("Closing a session"))
  }
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
  // Archive is offered by the pill every layout has, and the way back with it: a row an archive that
  // arrived by merge set aside is in no pill but Archived, and a row nothing could bring back is a
  // trap.
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
            <PopupTitle>{room ? "Edit room" : code ? "Edit session" : "Edit chat"}</PopupTitle>
          </PopupHeader>
          <div className="flex flex-col gap-6 px-4 pb-4 sm:px-6">
            {/* A room's name is its Host's, so the field waits for a Host that can write one; a chat's
                and a run's are this device's own row. Main's is Hermes's, and is drawn as the app's own
                word wherever a row or a bar names it. */}
            {(!room || roomHost) && !main && (
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
            {code && code.repos.length > 0 && (
              <section data-session-repos className="flex flex-col gap-2">
                <h3 className="px-1 text-sm font-medium">
                  {code.repos.length === 1 ? "Repository" : "Repositories"}
                </h3>
                <Group>
                  {code.repos.map((name) => (
                    <div key={name} className="flex min-h-14 items-center gap-4 bg-muted px-5 py-3">
                      <GitForkIcon className="size-5 shrink-0" />
                      <span className="min-w-0 flex-1 truncate text-base">{name}</span>
                    </div>
                  ))}
                </Group>
              </section>
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
              {open && !code && <PinRow chat={chat} profileId={profileId ?? chat.profileId} />}
              {code && (
                <SwitchRow
                  id="chat-pin"
                  data-chat-pin
                  icon={PinIcon}
                  title="Pin"
                  checked={Boolean(chat.pinned)}
                  onCheckedChange={(checked) =>
                    void updateConversation(chat.id, { pinned: checked ? true : undefined }).catch(
                      quietly("Pinning a session"),
                    )
                  }
                />
              )}
            </Group>
            <div className="flex flex-col gap-2">
              {code && !chat.discardedAt && (
                <Button
                  type="button"
                  variant="outline"
                  data-session-resolve
                  className="h-11 rounded-full"
                  onClick={() =>
                    void updateConversation(chat.id, {
                      resolvedAt: chat.resolvedAt ? undefined : Date.now(),
                    }).catch(quietly("Resolving a session"))
                  }
                >
                  {chat.resolvedAt ? (
                    <RotateCcwIcon data-icon="inline-start" />
                  ) : (
                    <CheckIcon data-icon="inline-start" />
                  )}
                  {chat.resolvedAt ? "Reopen" : "Resolve"}
                </Button>
              )}
              {code && !chat.discardedAt && (
                <Button
                  type="button"
                  variant="outline"
                  data-session-discard
                  className="h-11 rounded-full"
                  onClick={() => setDiscarding(true)}
                >
                  <ArchiveXIcon data-icon="inline-start" />
                  Discard
                </Button>
              )}
              {!code && mayArchive(chat) && (
                <Button
                  type="button"
                  variant="outline"
                  data-chat-archive
                  className="h-11 rounded-full"
                  onClick={() => {
                    const on = !chat.archived
                    // The sheet stays interactive while the write is out, so the archive press
                    // latches: one press is one write and one step back, and a second tap would
                    // write the mark twice and step back twice.
                    if (on) {
                      if (pressed.current) return
                      pressed.current = true
                    }
                    // The mark is written at once, as it always was, and the host's flag is asked
                    // for behind it (ADR 0159); the step back waits for the write's answer, since
                    // a row that was never put away is no way out of the conversation.
                    void setArchived(chat.id, on)
                      .catch(quietly("Archiving a chat"))
                      .then((stood) => {
                        if (!on) return
                        if (!stood) {
                          // A refused write is visible as the row simply not archived: the row is
                          // back as it was, so the sheet stands and the press may be made again.
                          pressed.current = false
                          return
                        }
                        onArchived?.()
                      })
                  }}
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
              {!room && !main && (
                <DestructiveButton onClick={() => setDeleting(true)}>
                  {code ? "Delete session" : "Delete chat"}
                </DestructiveButton>
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
          title={code ? "Delete this session?" : "Delete this chat?"}
          description={
            code
              ? CLOSE_WORDS +
                " It's removed from the app; Hermes keeps its own copy of the session."
              : "It's removed from this device. Hermes keeps its own copy of the session."
          }
          confirmLabel="Delete"
          onConfirm={async () => {
            // The row goes now, not when the host has finished: it is already closed, and the close
            // reports a kept worktree or a refusal when it ends (ADR 0080).
            if (code) closeSession()
            else stopMessage(chat.id)
            await deleteConversation(chat.id)
            onDeleted?.()
          }}
        />
      )}

      {code && (
        <ConfirmDestructive
          open={discarding}
          onOpenChange={setDiscarding}
          title="Discard this session?"
          description={CLOSE_WORDS + " The session moves to Discarded meanwhile."}
          confirmLabel="Discard"
          onConfirm={async () => {
            closeSession()
            await updateConversation(chat.id, { discardedAt: Date.now() })
          }}
        />
      )}
    </>
  )
}

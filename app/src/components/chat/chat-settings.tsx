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
import { pinSwitchOf } from "@/lib/chat-list"
import { setArchived, setPinned, usePinsInList } from "@/lib/chat-marks"
import { deleteConversation, updateConversation, type Conversation } from "@/lib/db"
import { useLegacyChat } from "@/lib/legacy-chat"
import { setThreadMuted } from "@/lib/push"
import { stopMessage } from "@/lib/chat"

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
 * A chat's own settings, from the press its bar's title answers.
 *
 * A chat's bar carries no `…` and no way to its bot's list — the list is where a conversation is
 * reached from, and back is how it is left (ADR 0153). What the menu that stood there held is this
 * sheet, as the rows the app's settings screens are drawn with: the name is typed where it is shown,
 * the mute and the pin are the switches of one card, the archive is the outline above the delete, and
 * the delete is the same confirmation the menu opened, asked in the same words.
 *
 * Everything here is the conversation's: a project session keeps its `…`, whose resolve, discard and
 * delete are not a chat's settings, and the bot's own mute and delete stay on its settings page.
 */
export function ChatSettings({
  chat,
  profileId,
  open,
  onOpenChange,
  onDeleted,
}: {
  chat: Conversation
  /**
   * The bot's list the pin cap is counted over: the profile this chat is a row of. The route passes it
   * rather than the record naming it, since a room lists in every bot its roster seats and the cap is
   * counted per list (`chat-marks.ts`).
   */
  profileId: string
  open: boolean
  onOpenChange: (open: boolean) => void
  /** Where to go once the chat is gone. */
  onDeleted: () => void
}) {
  const [deleting, setDeleting] = useState(false)
  const pins = usePinsInList(profileId)
  const pin = pinSwitchOf({ pinned: Boolean(chat.pinned) }, pins ?? [])
  // The Archived pill is the only way back to an archived row, and the legacy bands hold none: the
  // layout the pill belongs to is the one this sheet is drawn in, so the control waits for it.
  const archivesHere = useLegacyChat() === false
  // The field holds what is being typed, and the record what was last written: an edit abandoned or
  // refused leaves the name as it was.
  const [name, setName] = useState(chat.title)
  const saveName = () => {
    const next = name.trim()
    if (!next || next === chat.title) {
      setName(chat.title)
      return
    }
    void updateConversation(chat.id, { title: next, titleEdited: true })
  }

  return (
    <>
      <Popup open={open} onOpenChange={onOpenChange}>
        {/* The field is the sheet's first control, and a phone opens its keyboard for whichever
            control takes the focus — over a sheet the reader only just opened. */}
        <PopupContent initialFocus={false}>
          <PopupHeader className="pb-2">
            <PopupTitle>Edit chat</PopupTitle>
          </PopupHeader>
          <div className="flex flex-col gap-6 px-4 pb-4 sm:px-6">
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
                  onChange={(event) => setName(event.target.value)}
                  onBlur={saveName}
                  onKeyDown={(event) => {
                    if (event.key === "Enter") event.currentTarget.blur()
                  }}
                />
              </InputGroup>
            </div>
            <Group>
              <SwitchRow
                id="chat-muted"
                icon={BellOffIcon}
                title="Mute notifications"
                subtitle="Every push from this chat"
                checked={Boolean(chat.muted)}
                onCheckedChange={(checked) => void setThreadMuted(chat.id, checked)}
              />
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
            </Group>
            <div className="flex flex-col gap-2">
              {archivesHere && (
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
              {!chat.main && (
                <DestructiveButton onClick={() => setDeleting(true)}>Delete chat</DestructiveButton>
              )}
            </div>
          </div>
        </PopupContent>
      </Popup>

      <ConfirmDestructive
        open={deleting}
        onOpenChange={setDeleting}
        title="Delete this chat?"
        description="It's removed from this device. Hermes keeps its own copy of the session."
        confirmLabel="Delete"
        onConfirm={async () => {
          stopMessage(chat.id)
          await deleteConversation(chat.id)
          onDeleted()
        }}
      />
    </>
  )
}

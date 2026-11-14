import { useState } from "react"
import { BellOffIcon, MessageCircleIcon } from "lucide-react"

import { ConfirmDestructive } from "@/components/confirm-destructive"
import { RenameDialog } from "@/components/chat/rename-dialog"
import { ContextPercent, UsageSheet, type ContextUsage } from "@/components/chat/usage-sheet"
import { Popup, PopupContent, PopupHeader, PopupTitle } from "@/components/popup"
import {
  DestructiveButton,
  Group,
  RowText,
  SwitchRow,
  linkRowClass,
} from "@/components/settings-chrome"
import { deleteConversation, updateConversation, type Conversation, type Profile } from "@/lib/db"
import { setThreadMuted } from "@/lib/push"
import { stopMessage } from "@/lib/chat"

/**
 * A chat's bar's title as the press that opens its settings (ADR 0153): the whole block answers a
 * thumb — the header's `onTitlePress` — while this button is what a reader, a tab stop and a
 * keyboard activate, and its own presses bubble to the block.
 */
export function ChatTitlePress({
  title,
  open,
  onOpen,
}: {
  title: string
  open: boolean
  onOpen: () => void
}) {
  return (
    <button
      type="button"
      aria-haspopup="dialog"
      aria-expanded={open}
      data-chat-settings-open
      onClick={onOpen}
      className="flex min-h-11 w-full min-w-0 items-center text-left outline-none"
    >
      <span className="min-w-0 truncate">{title}</span>
    </button>
  )
}

/**
 * A chat's own settings, from the press its bar's title answers: its name, its notifications, its
 * context and the one control that ends it.
 *
 * A chat's bar carries no `…` and no way to its bot's list — the list is where a conversation is
 * reached from, and back is how it is left (ADR 0153). What the menu that stood there held is this
 * sheet, as the rows the app's settings screens are drawn with. The mute is a switch rather than a
 * menu item because it is a setting a reader comes to change, and the delete is the same confirmation
 * the menu opened, asked in the same words.
 *
 * Everything here is the conversation's: a project session keeps its `…`, whose resolve, discard and
 * delete are not a chat's settings, and the bot's own mute and delete stay on its settings page.
 */
export function ChatSettings({
  chat,
  open,
  onOpenChange,
  usage,
  providerUsage,
  context,
  usageOpen,
  onUsageOpenChange,
  onDeleted,
}: {
  chat: Conversation
  open: boolean
  onOpenChange: (open: boolean) => void
  usage: ContextUsage
  providerUsage?: Profile["providerUsage"]
  /** Whether the context row is offered: a callable bot, on a screen too narrow for the bar's ring. */
  context?: boolean
  /** The usage sheet, which the composer's limit notice opens too. */
  usageOpen: boolean
  onUsageOpenChange: (open: boolean) => void
  /** Where to go once the chat is gone. */
  onDeleted: () => void
}) {
  const [renaming, setRenaming] = useState(false)
  const [deleting, setDeleting] = useState(false)

  return (
    <>
      <Popup open={open} onOpenChange={onOpenChange}>
        <PopupContent>
          <PopupHeader className="pb-2">
            <PopupTitle>Edit chat</PopupTitle>
          </PopupHeader>
          <div className="flex flex-col gap-6 px-4 pb-4 sm:px-6">
            <Group>
              <button
                type="button"
                className={linkRowClass}
                data-chat-name
                onClick={() => setRenaming(true)}
              >
                <MessageCircleIcon className="size-5 shrink-0 text-muted-foreground" />
                <RowText title="Name" subtitle={chat.title} />
              </button>
              <SwitchRow
                id="chat-muted"
                icon={BellOffIcon}
                title="Mute notifications"
                subtitle="Every push from this chat"
                checked={Boolean(chat.muted)}
                onCheckedChange={(checked) => void setThreadMuted(chat.id, checked)}
              />
              {context && (
                <button
                  type="button"
                  className={linkRowClass}
                  data-chat-context
                  onClick={() => onUsageOpenChange(true)}
                >
                  <RowText title="Context" subtitle="This chat's context use" />
                  <ContextPercent usage={usage} />
                </button>
              )}
            </Group>
            {!chat.main && (
              <DestructiveButton onClick={() => setDeleting(true)}>Delete chat</DestructiveButton>
            )}
          </div>
        </PopupContent>
      </Popup>

      <UsageSheet
        open={usageOpen}
        onOpenChange={onUsageOpenChange}
        usage={usage}
        providerUsage={providerUsage}
      />

      <RenameDialog
        open={renaming}
        onOpenChange={setRenaming}
        title="Rename chat"
        fieldLabel="Chat title"
        value={chat.title}
        onSave={(name) => updateConversation(chat.id, { title: name, titleEdited: true })}
      />

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

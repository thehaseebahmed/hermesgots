import { useEffect, useState } from "react"
import { toast } from "sonner"
import {
  ArchiveXIcon,
  BellIcon,
  BellOffIcon,
  CheckIcon,
  EllipsisIcon,
  PencilIcon,
  RotateCcwIcon,
  SettingsIcon,
  Trash2Icon,
} from "lucide-react"

import {
  ContextIcon,
  ContextPercent,
  ContextRing,
  UsageSheet,
  type ContextUsage,
} from "@/components/chat/usage-sheet"
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog"
import { Button } from "@/components/ui/button"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { Input } from "@/components/ui/input"
import { stopMessage } from "@/lib/chat"
import { contextWindow } from "@/lib/context"
import {
  db,
  deleteConversation,
  updateConversation,
  type Conversation,
  type ModelChoice,
  type Profile,
} from "@/lib/db"
import { botModel, fullModel, useModelInfo } from "@/lib/model-info"
import { syncContextWindow, useModelCatalog } from "@/lib/models"
import {
  effectiveProvider,
  limitNotice,
  limitNoticeKey,
  refreshProviderUsage,
} from "@/lib/provider-usage"
import { setBotMuted, setThreadMuted } from "@/lib/push"
import { quietly } from "@/lib/report"
import { useNav } from "@/lib/nav"
import { closeSessionWork } from "@/lib/workspace"

/**
 * What a chat's header and the box above its composer say about its context and its provider's
 * limits, for the model it runs next: the chat's own pick, the bot's default, else what the host
 * last reported. It also keeps both reads fresh: the model's window when the connection changes,
 * and the provider's limits when the chat opens and when its provider changes (the chat's other
 * follow-up reads do the rest).
 */
export function useChatUsage(
  chat: Conversation | undefined | null,
  profile: Profile | undefined | null,
  pick: ModelChoice | undefined,
) {
  const tracked = Boolean(profile?.apiKey && !profile.disabled)
  const live = chat?.liveContext
  const hostInfo = useModelInfo(profile)
  const catalog = useModelCatalog()
  const currentModel = pick ?? (profile ? botModel(profile, hostInfo) : undefined)
  const usage: ContextUsage = {
    tracked,
    tokens: tracked ? live?.tokens : undefined,
    // The window belongs to the model the next turn runs, not the one the last call did: a switch
    // shows at once, rather than after the new model's first call.
    window: contextWindow(live, profile ?? undefined, currentModel, catalog),
    model: currentModel ? fullModel(currentModel) : undefined,
  }
  const provider = effectiveProvider(chat ?? undefined, profile ?? undefined)
  const providerUsage =
    profile?.providerUsage && profile.providerUsage.provider === provider
      ? profile.providerUsage
      : undefined
  const notice = limitNotice(providerUsage)
  const noticeDismissed =
    Boolean(notice && provider) && profile?.limitDismissed === limitNoticeKey(provider!, notice!)

  // Picks up a model changed on the server (only when the connection does, not on every write);
  // the ring follows via the live query.
  const profileId = profile?.id
  const baseUrl = profile?.baseUrl
  const apiKey = profile?.apiKey
  useEffect(() => {
    if (!profileId) return
    void db.profiles.get(profileId).then((current) => current && syncContextWindow(current))
  }, [profileId, baseUrl, apiKey])
  useEffect(() => {
    if (!profileId) return
    void refreshProviderUsage(profileId, provider).catch(quietly("Reading provider limits"))
  }, [profileId, baseUrl, apiKey, provider])

  return { usage, provider, providerUsage, notice, noticeDismissed }
}

/**
 * The chat's header controls and what they open: the context ring and its usage sheet, and the
 * options menu — rename, mute, resolve or reopen, discard and delete, or a bot's mute and settings
 * on its Main — with the dialogs they ask in. Both chat screens draw it.
 */
export function ChatActions({
  chat,
  profile,
  session,
  mainChrome,
  wide,
  usage,
  providerUsage,
  usageOpen,
  onUsageOpenChange,
  onDeleted,
}: {
  chat: Conversation
  profile?: Profile | null
  /** The chat as a project session, where it is one. */
  session?: Conversation
  /** A bot's Main drawn as the bot's face: its options are the bot's. */
  mainChrome: boolean
  wide: boolean
  usage: ContextUsage
  providerUsage?: Profile["providerUsage"]
  /** The usage sheet, which the limit banner above the composer opens too. */
  usageOpen: boolean
  onUsageOpenChange: (open: boolean) => void
  /** Where to go once the chat is gone. */
  onDeleted: () => void
}) {
  const { root } = useNav()
  const configured = Boolean(profile?.baseUrl.trim())
  const isMain = Boolean(chat.main)
  const [renaming, setRenaming] = useState(false)
  const [deleting, setDeleting] = useState(false)
  const [discarding, setDiscarding] = useState(false)
  const [title, setTitle] = useState("")

  /** Before a session is deleted or discarded: its run, worktrees, pull requests and branches. */
  const closeSession = async () => {
    if (!session) return
    stopMessage(session.id)
    const { kept, errors } = await closeSessionWork(session.id)
    for (const tree of kept)
      toast.info(
        `Kept ${tree.name}: it has ${tree.reason === "dirty" ? "uncommitted" : "unpushed"} changes.`,
      )
    for (const error of errors) toast.error(error)
  }

  return (
    <>
      <div className="flex items-center gap-2">
        {/* Main carries no reading of the context window: it belongs to a chat, and Main is the
            bot's face — the account's own notice below the composer still answers for the account. */}
        {wide && configured && !isMain && (
          <ContextRing usage={usage} onClick={() => onUsageOpenChange(true)} />
        )}
        <DropdownMenu>
          <DropdownMenuTrigger
            render={
              <Button
                variant="outline"
                size="icon-lg"
                className="size-11 rounded-full bg-background/80 backdrop-blur"
                aria-label={mainChrome ? "Bot options" : "Chat options"}
              />
            }
          >
            <EllipsisIcon />
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="min-w-44">
            {configured && !wide && !isMain && (
              <>
                <DropdownMenuItem onClick={() => onUsageOpenChange(true)}>
                  <ContextIcon usage={usage} />
                  Context
                  <ContextPercent usage={usage} />
                </DropdownMenuItem>
                <DropdownMenuSeparator />
              </>
            )}
            {/* Main has no title of its own to give: its header carries the bot's name, which Bot
                settings edits. */}
            {!isMain && (
              <DropdownMenuItem
                onClick={() => {
                  setTitle(chat.title)
                  setRenaming(true)
                }}
              >
                <PencilIcon />
                {session ? "Edit" : "Rename"}
              </DropdownMenuItem>
            )}
            {mainChrome && profile ? (
              <>
                <DropdownMenuItem onClick={() => void setBotMuted(profile.id, !profile.muted)}>
                  {profile.muted ? <BellIcon /> : <BellOffIcon />}
                  {profile.muted ? "Unmute notifications" : "Mute notifications"}
                </DropdownMenuItem>
                <DropdownMenuSeparator />
                <DropdownMenuItem onClick={() => root("/settings/bots")}>
                  <SettingsIcon />
                  Bot settings
                </DropdownMenuItem>
              </>
            ) : (
              <>
                <DropdownMenuItem onClick={() => void setThreadMuted(chat.id, !chat.muted)}>
                  {chat.muted ? <BellIcon /> : <BellOffIcon />}
                  {chat.muted ? "Unmute notifications" : "Mute notifications"}
                </DropdownMenuItem>
                {session &&
                  !session.discardedAt &&
                  (session.resolvedAt ? (
                    <DropdownMenuItem
                      onClick={() => updateConversation(session.id, { resolvedAt: undefined })}
                    >
                      <RotateCcwIcon />
                      Reopen
                    </DropdownMenuItem>
                  ) : (
                    <DropdownMenuItem
                      onClick={() => updateConversation(session.id, { resolvedAt: Date.now() })}
                    >
                      <CheckIcon />
                      Resolve
                    </DropdownMenuItem>
                  ))}
                {!chat.main && (
                  <>
                    <DropdownMenuSeparator />
                    {session && !session.discardedAt && (
                      <DropdownMenuItem onClick={() => setDiscarding(true)}>
                        <ArchiveXIcon />
                        Discard
                      </DropdownMenuItem>
                    )}
                    <DropdownMenuItem variant="destructive" onClick={() => setDeleting(true)}>
                      <Trash2Icon />
                      Delete
                    </DropdownMenuItem>
                  </>
                )}
              </>
            )}
          </DropdownMenuContent>
        </DropdownMenu>
      </div>

      <UsageSheet
        open={usageOpen}
        onOpenChange={onUsageOpenChange}
        usage={usage}
        providerUsage={providerUsage}
      />

      <AlertDialog open={renaming} onOpenChange={setRenaming}>
        <AlertDialogContent>
          <form
            className="contents"
            onSubmit={async (event) => {
              event.preventDefault()
              if (title.trim())
                await updateConversation(chat.id, { title: title.trim(), titleEdited: true })
              setRenaming(false)
            }}
          >
            <AlertDialogHeader>
              <AlertDialogTitle>{session ? "Edit session" : "Rename chat"}</AlertDialogTitle>
            </AlertDialogHeader>
            <Input
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              autoFocus
              aria-label="Chat title"
            />
            <AlertDialogFooter>
              <AlertDialogCancel>Cancel</AlertDialogCancel>
              <AlertDialogAction type="submit">Save</AlertDialogAction>
            </AlertDialogFooter>
          </form>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog open={deleting} onOpenChange={setDeleting}>
        <AlertDialogContent size="sm">
          <AlertDialogHeader>
            <AlertDialogTitle>
              {session ? "Delete this session?" : "Delete this chat?"}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {session
                ? "Its pull request is closed and its branch deleted on GitHub, and it's removed from the app. Hermes keeps its own copy of the session."
                : "It's removed from this device. Hermes keeps its own copy of the session."}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              onClick={async () => {
                if (session) await closeSession()
                else stopMessage(chat.id)
                await deleteConversation(chat.id)
                setDeleting(false)
                onDeleted()
              }}
            >
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog open={discarding} onOpenChange={setDiscarding}>
        <AlertDialogContent size="sm">
          <AlertDialogHeader>
            <AlertDialogTitle>Discard this session?</AlertDialogTitle>
            <AlertDialogDescription>
              Its pull request is closed and its branch deleted on GitHub. The session moves to
              Discarded.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              onClick={async () => {
                if (session) {
                  await closeSession()
                  await updateConversation(session.id, { discardedAt: Date.now() })
                }
                setDiscarding(false)
              }}
            >
              Discard
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  )
}

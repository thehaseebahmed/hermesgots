import { useEffect, useRef, useState } from "react"
import { useLiveQuery } from "dexie-react-hooks"
import { Link, useNavigate, useParams } from "react-router"
import { toast } from "sonner"
import { EllipsisIcon, PencilIcon, PlusIcon, SettingsIcon, Trash2Icon } from "lucide-react"

import { ApprovalCard } from "@/components/chat/approval-card"
import { ChatHeader } from "@/components/chat/chat-header"
import { Composer } from "@/components/chat/composer"
import { MessageItem } from "@/components/chat/message-item"
import { ContextRing, UsageSheet, type ContextUsage } from "@/components/chat/usage-sheet"
import { Bot } from "@/components/bot"
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
import {
  MessageScroller,
  MessageScrollerButton,
  MessageScrollerContent,
  MessageScrollerItem,
  MessageScrollerProvider,
  MessageScrollerViewport,
  useMessageScroller,
} from "@/components/ui/message-scroller"
import { Spinner } from "@/components/ui/spinner"
import { queueMessage, sendMessage, stopMessage } from "@/lib/chat"
import {
  DEFAULT_SETTINGS,
  createConversation,
  db,
  deleteConversation,
  getActiveProfile,
  getMessages,
  updateConversation,
  type Message,
} from "@/lib/db"
import { loadEarlierHistory, reconcileHistory } from "@/lib/history"
import { syncContextWindow } from "@/lib/models"

/** How often an open chat checks Hermes for turns sent from another device. */
const CATCH_UP_MS = 30_000

const wait = (ms: number) => new Promise((resolve) => window.setTimeout(resolve, ms))

const SUGGESTIONS = [
  "What can you do on my machine?",
  "Summarise what you remember about me",
  "Check disk usage under /var/log",
]

function EmptyState({
  name,
  botId,
  configured,
  onPick,
}: {
  name: string
  botId?: string
  configured: boolean
  onPick: (text: string) => void
}) {
  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-6 px-4 pt-24 pb-8 text-center">
      <Bot id={botId} animate className="size-24" />
      <div className="space-y-1.5">
        <h1 className="text-2xl font-semibold tracking-tight">Hey, I'm {name}</h1>
        <p className="max-w-sm text-sm text-muted-foreground">
          {configured
            ? "Ask me anything. I can run tools on your machine and I'll ask before doing anything risky."
            : "Point Memento at your Hermes Agent API server to start chatting."}
        </p>
      </div>
      {configured ? (
        <div className="flex max-w-md flex-wrap justify-center gap-2">
          {SUGGESTIONS.map((text) => (
            <Button
              key={text}
              variant="outline"
              className="h-auto min-h-10 rounded-full whitespace-normal"
              onClick={() => onPick(text)}
            >
              {text}
            </Button>
          ))}
        </div>
      ) : (
        <Button nativeButton={false} render={<Link to="/settings" />} size="lg">
          <SettingsIcon data-icon="inline-start" />
          Open settings
        </Button>
      )}
    </div>
  )
}

/** The approval card temporarily replaces the composer; once answered, follow the reply again. */
function FollowAfterApproval({ pending }: { pending: boolean }) {
  const { scrollToEnd } = useMessageScroller()
  const wasPending = useRef(pending)
  useEffect(() => {
    if (wasPending.current && !pending) scrollToEnd({ behavior: "smooth" })
    wasPending.current = pending
  }, [pending, scrollToEnd])
  return null
}

/** Sending jumps back to the end, even if you'd scrolled up to read. */
function FollowOnSend({ lastUserId }: { lastUserId?: string }) {
  const { scrollToEnd } = useMessageScroller()
  const previous = useRef(lastUserId)
  useEffect(() => {
    if (lastUserId !== previous.current) scrollToEnd({ behavior: "smooth" })
    previous.current = lastUserId
  }, [lastUserId, scrollToEnd])
  return null
}

export function ChatPage() {
  const { id } = useParams()
  const navigate = useNavigate()
  const settings = useLiveQuery(() => db.settings.get("settings"), [])
  const conversation = useLiveQuery(
    async () => (id ? ((await db.conversations.get(id)) ?? null) : undefined),
    [id],
  )
  // A chat talks to its own bot; a new chat goes to the selected one.
  const profile = useLiveQuery(async () => {
    const owner = id ? (await db.conversations.get(id))?.profileId : undefined
    return ((owner && (await db.profiles.get(owner))) || (await getActiveProfile())) ?? null
  }, [id])
  const messages = useLiveQuery(() => (id ? getMessages(id) : []), [id])
  const [renaming, setRenaming] = useState(false)
  const [deleting, setDeleting] = useState(false)
  const [title, setTitle] = useState("")
  const [usageOpen, setUsageOpen] = useState(false)
  const [loadingEarlier, setLoadingEarlier] = useState(false)
  const [historyMissing, setHistoryMissing] = useState<string>()

  const resolved = { ...DEFAULT_SETTINGS, ...settings }
  const configured = Boolean(profile?.baseUrl.trim())
  const streaming = messages?.find((m) => m.status === "streaming")
  const busy = Boolean(streaming)
  const awaitingApproval = messages?.find((m) => m.approval && !m.approval.resolved)
  const activity = streaming && describeActivity(streaming)
  const lastTurn = messages?.findLast((m) => m.stats?.promptTokens)?.stats
  // The plugin's figure is exact and the same on every device. Without it, the chat's own figure
  // follows turns run on other devices; older chats only have their stats.
  const live = conversation?.liveContext
  const usage: ContextUsage = {
    tokens: live?.tokens ?? conversation?.contextTokens ?? lastTurn?.promptTokens,
    approximate: live
      ? false
      : conversation?.contextTokens
        ? conversation.contextApproximate
        : lastTurn?.toolsUsed,
    window:
      profile?.contextSource === "manual"
        ? profile.contextWindow
        : (live?.window ?? profile?.contextWindow),
  }

  // Picks up a model changed on the server (only when the connection does, not on every write);
  // the ring follows via the live query.
  const profileId = profile?.id
  const connection = profile && `${profile.baseUrl}\n${profile.apiKey}`
  useEffect(() => {
    if (!profileId) return
    void db.profiles.get(profileId).then((current) => current && syncContextWindow(current))
  }, [profileId, connection])

  // A chat synced from another device arrives empty; its transcript is on Hermes.
  const needsHistory =
    Boolean(conversation && conversation.updatedAt > conversation.createdAt) &&
    messages?.length === 0
  const loadingHistory = needsHistory && historyMissing !== id
  useEffect(() => {
    if (!id || !needsHistory) return
    reconcileHistory(id)
      .then((count) => count || setHistoryMissing(id))
      .catch((error) => {
        setHistoryMissing(id)
        toast.error(error instanceof Error ? error.message : "Couldn't load this chat.")
      })
  }, [id, needsHistory])

  // Other devices add turns on Hermes. Catch up when the chat opens, when sync brings news of it,
  // when this tab comes back, and now and then while it's on screen.
  const updatedAt = conversation?.updatedAt
  const hasMessages = (messages?.length ?? 0) > 0
  useEffect(() => {
    if (!id || !hasMessages) return
    const catchUp = () => {
      if (document.visibilityState === "visible") reconcileHistory(id).catch(() => undefined)
    }
    catchUp()
    const timer = window.setInterval(catchUp, CATCH_UP_MS)
    document.addEventListener("visibilitychange", catchUp)
    window.addEventListener("online", catchUp)
    return () => {
      window.clearInterval(timer)
      document.removeEventListener("visibilitychange", catchUp)
      window.removeEventListener("online", catchUp)
    }
  }, [id, hasMessages, updatedAt])

  // A deleted (or unknown) conversation id falls back to a fresh chat.
  useEffect(() => {
    if (id && conversation === null) navigate("/", { replace: true })
  }, [id, conversation, navigate])

  const send = async (text: string) => {
    try {
      let conversationId = id
      if (conversationId) {
        // So a reply that builds on another device's latest turn shows after it, not before.
        await Promise.race([reconcileHistory(conversationId).catch(() => undefined), wait(1500)])
      } else {
        if (!profile) return
        conversationId = (await createConversation(profile.id)).id
        navigate(`/c/${conversationId}`)
      }
      await sendMessage(conversationId, text)
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Couldn't send your message.")
      throw error
    }
  }

  const actions = (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={
          <Button
            variant="outline"
            size="icon-lg"
            className="size-11 rounded-full bg-background/80 backdrop-blur"
            aria-label="Chat options"
          />
        }
      >
        <EllipsisIcon />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="min-w-44">
        <DropdownMenuItem onClick={() => navigate("/")}>
          <PlusIcon />
          New chat
        </DropdownMenuItem>
        {conversation && (
          <>
            <DropdownMenuItem
              onClick={() => {
                setTitle(conversation.title)
                setRenaming(true)
              }}
            >
              <PencilIcon />
              Rename
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem variant="destructive" onClick={() => setDeleting(true)}>
              <Trash2Icon />
              Delete
            </DropdownMenuItem>
          </>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  )

  return (
    <div className="relative flex min-h-0 flex-1 flex-col">
      <ChatHeader
        title={conversation?.title ?? "New chat"}
        subtitle={activity}
        botId={profile?.botId}
        actions={actions}
      />

      {hasMessages ? (
        <MessageScrollerProvider autoScroll defaultScrollPosition="end">
          <MessageScroller className="flex-1">
            <MessageScrollerViewport aria-label="Messages">
              <MessageScrollerContent className="mx-auto w-full max-w-3xl gap-6 px-4 pt-32 pb-6">
                {conversation?.olderThan && (
                  <Button
                    variant="outline"
                    className="min-h-11 self-center rounded-full"
                    disabled={loadingEarlier}
                    onClick={() => {
                      setLoadingEarlier(true)
                      loadEarlierHistory(conversation.id)
                        .catch((error) =>
                          toast.error(
                            error instanceof Error ? error.message : "Couldn't load more.",
                          ),
                        )
                        .finally(() => setLoadingEarlier(false))
                    }}
                  >
                    Load earlier messages
                  </Button>
                )}
                {messages!.map((message) => (
                  <MessageScrollerItem key={message.id} messageId={message.id}>
                    <MessageItem
                      message={message}
                      showStats={resolved.showStats}
                      botId={profile?.botId}
                      busy={busy}
                    />
                  </MessageScrollerItem>
                ))}
              </MessageScrollerContent>
            </MessageScrollerViewport>
            <MessageScrollerButton />
            <FollowAfterApproval pending={Boolean(awaitingApproval)} />
            <FollowOnSend lastUserId={messages!.findLast((m) => m.role === "user")?.id} />
          </MessageScroller>
        </MessageScrollerProvider>
      ) : loadingHistory ? (
        <div className="flex flex-1 items-center justify-center">
          <Spinner className="size-6" />
        </div>
      ) : (
        <EmptyState
          name={profile?.name ?? "Hermes"}
          botId={profile?.botId}
          configured={configured}
          onPick={(text) => void send(text).catch(() => {})}
        />
      )}

      <div className="px-3 pb-[max(0.75rem,env(safe-area-inset-bottom))] sm:px-4">
        {awaitingApproval ? (
          <div className="mx-auto w-full max-w-3xl">
            <ApprovalCard message={awaitingApproval} />
          </div>
        ) : (
          <Composer
            busy={busy}
            disabled={!configured}
            onSend={send}
            onQueue={(text) => (id ? queueMessage(id, text) : send(text))}
            onStop={() => id && stopMessage(id)}
            onCommand={(command) => navigate(command === "new" ? "/" : "/settings")}
            connection={{ baseUrl: profile?.baseUrl ?? "", apiKey: profile?.apiKey ?? "" }}
            botName={profile?.name}
            leading={
              hasMessages && configured ? (
                <ContextRing usage={usage} onClick={() => setUsageOpen(true)} />
              ) : undefined
            }
          />
        )}
      </div>

      <UsageSheet open={usageOpen} onOpenChange={setUsageOpen} usage={usage} profile={profile} />

      <AlertDialog open={renaming} onOpenChange={setRenaming}>
        <AlertDialogContent>
          <form
            className="contents"
            onSubmit={async (event) => {
              event.preventDefault()
              if (id && title.trim())
                await updateConversation(id, { title: title.trim(), titleEdited: true })
              setRenaming(false)
            }}
          >
            <AlertDialogHeader>
              <AlertDialogTitle>Rename chat</AlertDialogTitle>
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
            <AlertDialogTitle>Delete this chat?</AlertDialogTitle>
            <AlertDialogDescription>
              It's removed from this device. Hermes keeps its own copy of the session.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              onClick={async () => {
                if (id) {
                  stopMessage(id)
                  await deleteConversation(id)
                }
                setDeleting(false)
                navigate("/", { replace: true })
              }}
            >
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}

/** One line saying what the bot is doing right now. */
function describeActivity(message: Message) {
  if (message.approval && !message.approval.resolved) return "Waiting for approval"
  const tool = message.tools?.findLast((t) => t.status === "running")
  if (tool) return `${tool.emoji ? `${tool.emoji} ` : ""}${tool.label}…`
  if (message.statusText) return message.statusText
  if (message.reasoning && !message.content) return "Thinking…"
  return "Writing…"
}

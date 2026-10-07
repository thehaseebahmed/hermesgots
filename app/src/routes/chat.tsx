import { useCallback, useEffect, useRef, useState } from "react"
import { useLiveQuery } from "dexie-react-hooks"
import { Link, useNavigate, useParams } from "react-router"
import { toast } from "sonner"
import {
  ArrowLeftIcon,
  CheckIcon,
  EllipsisIcon,
  PencilIcon,
  PlusIcon,
  RotateCcwIcon,
  SettingsIcon,
  Trash2Icon,
} from "lucide-react"

import { ApprovalCard } from "@/components/chat/approval-card"
import { BotPicker } from "@/components/chat/bot-picker"
import { ChatHeader } from "@/components/chat/chat-header"
import { Composer } from "@/components/chat/composer"
import { MessageItem } from "@/components/chat/message-item"
import { PrPill } from "@/components/chat/pr-pill"
import { QuestionCard } from "@/components/chat/question-card"
import { BlockedCard, PlanReadyCard, ResolvedCard } from "@/components/chat/session-cards"
import { TodosPill, TodosSheet } from "@/components/chat/todos"
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
import { queueMessage, reattachRun, sendMessage, stopMessage } from "@/lib/chat"
import {
  DEFAULT_SETTINGS,
  type Attachment,
  createConversation,
  db,
  deleteConversation,
  getActiveProfile,
  getMessages,
  updateConversation,
} from "@/lib/db"
import { describeActivity } from "@/lib/format"
import { loadEarlierHistory, reconcileHistory } from "@/lib/history"
import { setBackGuard } from "@/lib/native"
import { useNav } from "@/lib/nav"
import { syncContextWindow } from "@/lib/models"
import {
  planApprovalMessage,
  refreshWorkspace,
  removeSessionWorkspace,
  setSessionMode,
} from "@/lib/workspace"

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
        <Button nativeButton={false} render={<Link to="/settings" replace />} size="lg">
          <SettingsIcon data-icon="inline-start" />
          Open settings
        </Button>
      )}
    </div>
  )
}

/** An approval or question card temporarily replaces the composer; once answered, follow the reply again. */
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
  const { root, up } = useNav()
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
  const [todosOpen, setTodosOpen] = useState(false)
  const [loadingEarlier, setLoadingEarlier] = useState(false)
  const [historyMissing, setHistoryMissing] = useState<string>()

  const resolved = { ...DEFAULT_SETTINGS, ...settings }
  const configured = Boolean(profile?.baseUrl.trim())
  const streaming = messages?.find((m) => m.status === "streaming")
  const busy = Boolean(streaming)
  const awaitingApproval = messages?.find((m) => m.approval && !m.approval.resolved)
  const awaitingClarify = messages?.find((m) => m.clarify && !m.clarify.resolved)
  const activity = streaming && describeActivity(streaming)
  // Only the plugin sees each model call; Hermes's API sums a turn's calls, so nothing else is exact.
  const tracked = Boolean(profile?.apiKey && profile.pluginChats)
  const live = conversation?.liveContext
  const todos = (tracked && conversation?.todos?.items) || []
  // A session of a Hermes Project: works in its worktree, with a mode, a PR and a resolved state.
  const session = conversation?.projectId ? conversation : undefined
  const usage: ContextUsage = {
    tracked,
    tokens: tracked ? live?.tokens : undefined,
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

  // The plugin holds a session's mode and pending plan; an empty session never catches up below.
  const sessionId = session?.id
  useEffect(() => {
    if (sessionId) void refreshWorkspace(sessionId)
  }, [sessionId])

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
      if (document.visibilityState !== "visible") return
      reattachRun(id).catch(() => undefined)
      reconcileHistory(id).catch(() => undefined)
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
    if (id && conversation === null) root("/")
  }, [id, conversation, root])

  // A session that was never sent anything isn't kept; typed text is the user's to keep or drop.
  const draftRef = useRef("")
  const onDraft = useCallback((text: string) => {
    draftRef.current = text
  }, [])
  const [leavingWithDraft, setLeavingWithDraft] = useState(false)
  const unsent =
    session !== undefined && messages?.length === 0 && !(session.updatedAt > session.createdAt)
  const projectPath = session && `/code/${session.profileId}/${session.projectId}`
  const leave = () => {
    if (!session || !projectPath) return
    if (!unsent) return up(projectPath)
    if (draftRef.current.trim()) return setLeavingWithDraft(true)
    void deleteConversation(session.id)
    up(projectPath)
  }
  const leaveRef = useRef(leave)
  useEffect(() => {
    leaveRef.current = leave
  })
  // A session sits under its project; a plain chat is top-level, so back leaves the app.
  useEffect(() => {
    if (!projectPath) return
    return setBackGuard(() => {
      leaveRef.current()
      return true
    })
  }, [projectPath])

  const send = async (text: string, attachments: Attachment[] = []) => {
    try {
      let conversationId = id
      if (conversationId) {
        // So a reply that builds on another device's latest turn shows after it, not before.
        await Promise.race([reconcileHistory(conversationId).catch(() => undefined), wait(1500)])
      } else {
        if (!profile) return
        conversationId = (await createConversation(profile.id)).id
        navigate(`/c/${conversationId}`, { replace: true })
      }
      if (session?.draftAt)
        void updateConversation(conversationId, { draft: undefined, draftAt: undefined })
      await sendMessage(conversationId, text, { attachments })
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
        {!session && (
          <DropdownMenuItem onClick={() => root("/")}>
            <PlusIcon />
            New chat
          </DropdownMenuItem>
        )}
        {conversation && (
          <>
            <DropdownMenuItem
              onClick={() => {
                setTitle(conversation.title)
                setRenaming(true)
              }}
            >
              <PencilIcon />
              {session ? "Edit" : "Rename"}
            </DropdownMenuItem>
            {session &&
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
        subtitle={activity ?? session?.worktree?.branch}
        botId={profile?.botId}
        actions={actions}
        leading={
          session && (
            <Button
              variant="outline"
              size="icon-lg"
              className="size-11 rounded-full bg-background/80 backdrop-blur"
              onClick={leave}
              aria-label="Back to project"
            >
              <ArrowLeftIcon />
            </Button>
          )
        }
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
                      plain={Boolean(session)}
                    />
                  </MessageScrollerItem>
                ))}
              </MessageScrollerContent>
            </MessageScrollerViewport>
            <MessageScrollerButton />
            <FollowAfterApproval pending={Boolean(awaitingApproval || awaitingClarify)} />
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
        {(todos.length > 0 || (session?.prs?.length ?? 0) > 0) && (
          // One line, centred; wider than the screen it scrolls, from the first pill.
          <div className="-mx-3 flex [scrollbar-width:none] overflow-x-auto px-3 pb-2 sm:-mx-4 sm:px-4 [&::-webkit-scrollbar]:hidden">
            <div className="mx-auto flex w-max max-w-none min-w-full shrink-0 justify-center gap-2">
              {todos.length > 0 && <TodosPill items={todos} onClick={() => setTodosOpen(true)} />}
              {session?.prs?.map((pr) => (
                <PrPill
                  key={pr.repo}
                  pr={pr}
                  named={(session.worktree?.repos.length ?? 0) > 1}
                  className="shrink-0"
                />
              ))}
            </div>
          </div>
        )}
        {!id && profile && (
          <div className="mx-auto flex w-full max-w-3xl pb-2">
            <BotPicker profile={profile} />
          </div>
        )}
        {session?.resolvedAt ? (
          <div className="mx-auto w-full max-w-3xl">
            <ResolvedCard
              onReopen={() => updateConversation(session.id, { resolvedAt: undefined })}
            />
          </div>
        ) : awaitingApproval ? (
          <div className="mx-auto w-full max-w-3xl">
            <ApprovalCard message={awaitingApproval} />
          </div>
        ) : awaitingClarify ? (
          <div className="mx-auto w-full max-w-3xl">
            <QuestionCard key={awaitingClarify.clarify!.clarifyId} message={awaitingClarify} />
          </div>
        ) : session?.blocked && !busy ? (
          <div className="mx-auto w-full max-w-3xl">
            <BlockedCard reason={session.blocked} />
          </div>
        ) : session?.planPending && session.mode === "plan" && !busy ? (
          <div className="mx-auto w-full max-w-3xl">
            <PlanReadyCard
              onApprove={async () => {
                await setSessionMode(session.id, "auto")
                await send(planApprovalMessage(session.planFile))
              }}
              onKeepPlanning={() => setSessionMode(session.id, "plan")}
            />
          </div>
        ) : (
          <Composer
            busy={busy}
            disabled={!configured}
            draft={session?.draft}
            onDraft={onDraft}
            onSend={send}
            onQueue={(text, attachments) =>
              id ? queueMessage(id, text, attachments) : send(text, attachments)
            }
            filesAvailable={Boolean(profile?.pluginChats)}
            imagesAvailable={profile?.imageInput !== false}
            onStop={() => id && stopMessage(id)}
            onCommand={(command) => root(command === "new" ? "/" : "/settings")}
            connection={{ baseUrl: profile?.baseUrl ?? "", apiKey: profile?.apiKey ?? "" }}
            botName={profile?.name}
            session={
              session && {
                // Without the plugin nothing answers for Auto, so the session runs as Accept edits.
                mode:
                  session.mode === "auto" && !tracked
                    ? "accept_edits"
                    : (session.mode ?? "accept_edits"),
                autoAvailable: tracked,
                onMode: (mode) =>
                  setSessionMode(session.id, mode).catch((error) =>
                    toast.error(
                      error instanceof Error ? error.message : "Couldn't change the mode.",
                    ),
                  ),
              }
            }
            leading={
              hasMessages && configured ? (
                <ContextRing usage={usage} onClick={() => setUsageOpen(true)} />
              ) : undefined
            }
          />
        )}
      </div>

      <UsageSheet open={usageOpen} onOpenChange={setUsageOpen} usage={usage} profile={profile} />
      <TodosSheet open={todosOpen} onOpenChange={setTodosOpen} items={todos} />

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

      <AlertDialog open={leavingWithDraft} onOpenChange={setLeavingWithDraft}>
        <AlertDialogContent size="sm">
          <AlertDialogHeader>
            <AlertDialogTitle>Save your draft?</AlertDialogTitle>
            <AlertDialogDescription>
              This session hasn't started. Save the draft to pick it up later, or discard the
              session.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogAction
              variant="outline"
              onClick={async () => {
                if (!session || !projectPath) return
                await deleteConversation(session.id)
                up(projectPath)
              }}
            >
              Discard
            </AlertDialogAction>
            <AlertDialogAction
              onClick={async () => {
                if (!session || !projectPath) return
                await updateConversation(session.id, {
                  draft: draftRef.current.trim(),
                  draftAt: Date.now(),
                })
                up(projectPath)
              }}
            >
              Save draft
            </AlertDialogAction>
          </AlertDialogFooter>
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
                ? "It's removed from this device, and its worktrees from the server unless they have uncommitted or unpushed work. Hermes keeps its own copy of the session."
                : "It's removed from this device. Hermes keeps its own copy of the session."}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              onClick={async () => {
                if (id) {
                  stopMessage(id)
                  if (session) {
                    const result = await removeSessionWorkspace(id)
                    for (const kept of result.kept)
                      toast.info(
                        `Kept ${kept.name}: it has ${kept.reason === "dirty" ? "uncommitted" : "unpushed"} changes.`,
                      )
                    if (result.error) toast.error(result.error)
                  }
                  await deleteConversation(id)
                }
                setDeleting(false)
                if (projectPath) up(projectPath)
                else root("/")
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

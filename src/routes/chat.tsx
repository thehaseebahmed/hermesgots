import { useEffect, useState } from "react"
import { useLiveQuery } from "dexie-react-hooks"
import { Link, useNavigate, useParams } from "react-router"
import { EllipsisIcon, PencilIcon, PlusIcon, SettingsIcon, Trash2Icon } from "lucide-react"

import { ChatHeader } from "@/components/chat/chat-header"
import { Composer } from "@/components/chat/composer"
import { MessageItem } from "@/components/chat/message-item"
import { Mascot } from "@/components/mascot"
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
} from "@/components/ui/message-scroller"
import { sendMessage, stopMessage } from "@/lib/chat"
import { DEFAULT_SETTINGS, createConversation, db, deleteConversation, getMessages } from "@/lib/db"

const SUGGESTIONS = [
  "What can you do on my machine?",
  "Summarise what you remember about me",
  "Check disk usage under /var/log",
]

function EmptyState({
  configured,
  onPick,
}: {
  configured: boolean
  onPick: (text: string) => void
}) {
  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-6 px-4 pt-24 pb-8 text-center">
      <Mascot className="size-20" />
      <div className="space-y-1.5">
        <h1 className="text-2xl font-semibold tracking-tight">Hey, I'm Hermes</h1>
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

export function ChatPage() {
  const { id } = useParams()
  const navigate = useNavigate()
  const settings = useLiveQuery(() => db.settings.get("settings"), [])
  const conversation = useLiveQuery(
    async () => (id ? ((await db.conversations.get(id)) ?? null) : undefined),
    [id],
  )
  const messages = useLiveQuery(() => (id ? getMessages(id) : []), [id])
  const [renaming, setRenaming] = useState(false)
  const [deleting, setDeleting] = useState(false)
  const [title, setTitle] = useState("")

  const resolved = { ...DEFAULT_SETTINGS, ...settings }
  const configured = Boolean(resolved.baseUrl.trim())
  const busy = messages?.some((m) => m.status === "streaming") ?? false

  // A deleted (or unknown) conversation id falls back to a fresh chat.
  useEffect(() => {
    if (id && conversation === null) navigate("/", { replace: true })
  }, [id, conversation, navigate])

  const send = async (text: string) => {
    let conversationId = id
    if (!conversationId) {
      conversationId = (await createConversation()).id
      navigate(`/c/${conversationId}`)
    }
    void sendMessage(conversationId, text)
  }

  const host = (() => {
    try {
      return new URL(resolved.baseUrl).host
    } catch {
      return "not connected"
    }
  })()

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

  const hasMessages = (messages?.length ?? 0) > 0

  return (
    <div className="relative flex min-h-0 flex-1 flex-col">
      <ChatHeader
        title={conversation?.title ?? "New chat"}
        subtitle={busy ? "Writing…" : host}
        busy={busy}
        actions={actions}
      />

      {hasMessages ? (
        <MessageScrollerProvider autoScroll defaultScrollPosition="end">
          <MessageScroller className="flex-1">
            <MessageScrollerViewport aria-label="Messages">
              <MessageScrollerContent className="mx-auto w-full max-w-3xl gap-6 px-4 pt-32 pb-6">
                {messages!.map((message) => (
                  <MessageScrollerItem
                    key={message.id}
                    messageId={message.id}
                    scrollAnchor={message.role === "user"}
                  >
                    <MessageItem message={message} showStats={resolved.showStats} />
                  </MessageScrollerItem>
                ))}
              </MessageScrollerContent>
            </MessageScrollerViewport>
            <MessageScrollerButton />
          </MessageScroller>
        </MessageScrollerProvider>
      ) : (
        <EmptyState configured={configured} onPick={send} />
      )}

      <div className="px-3 pb-[max(0.75rem,env(safe-area-inset-bottom))] sm:px-4">
        <Composer
          busy={busy}
          disabled={!configured}
          onSend={send}
          onStop={() => id && stopMessage(id)}
        />
      </div>

      <AlertDialog open={renaming} onOpenChange={setRenaming}>
        <AlertDialogContent>
          <form
            className="contents"
            onSubmit={async (event) => {
              event.preventDefault()
              if (id && title.trim()) await db.conversations.update(id, { title: title.trim() })
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

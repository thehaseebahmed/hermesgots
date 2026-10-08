import { Fragment, useEffect, useLayoutEffect, useRef } from "react"
import { useLiveQuery } from "dexie-react-hooks"
import { Link, useNavigate, useParams } from "react-router"
import { toast } from "sonner"
import {
  CheckIcon,
  ChevronRightIcon,
  CircleAlertIcon,
  CircleXIcon,
  EllipsisIcon,
  SettingsIcon,
} from "lucide-react"

import { ChatHeader } from "@/components/chat/chat-header"
import { Composer } from "@/components/chat/composer"
import { Bot } from "@/components/bot"
import { Bubble, BubbleContent } from "@/components/ui/bubble"
import { Button } from "@/components/ui/button"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { Spinner } from "@/components/ui/spinner"
import { sendMessage } from "@/lib/chat"
import { createConversation, db, setActiveProfile, type Attachment } from "@/lib/db"
import { useNav } from "@/lib/nav"
import { useNow, useThreads, type Thread } from "@/lib/threads"
import { cn } from "@/lib/utils"
import { reasonText } from "@/lib/waiting"
import { SUGGESTIONS } from "@/lib/suggestions"

const dayFormat = new Intl.DateTimeFormat(undefined, {
  weekday: "long",
  month: "long",
  day: "numeric",
})

function dayOf(timestamp: number, now: number) {
  const day = new Date(timestamp).toDateString()
  if (day === new Date(now).toDateString()) return "Today"
  if (day === new Date(now - 86_400_000).toDateString()) return "Yesterday"
  return dayFormat.format(timestamp)
}

/** The thread's state as the card's leading icon, like a project session's. */
function StateIcon({ state }: { state: Thread["state"] }) {
  if (state === "waiting") return <CircleAlertIcon className="size-5 text-warning" />
  if (state === "failed") return <CircleXIcon className="size-5 text-destructive" />
  if (state === "working") return <Spinner className="size-5" />
  return (
    <span className="flex size-5 items-center justify-center rounded-full bg-success text-background">
      <CheckIcon className="size-3.5" strokeWidth={3} />
    </span>
  )
}

/**
 * One thread: what it was opened with, then from the bot, left aligned, a card with its state and
 * title and a link to open it.
 */
function ThreadItem({
  thread,
  botId,
  profileId,
  open,
  beside,
}: {
  thread: Thread
  botId?: string
  profileId: string
  open: boolean
  beside: boolean
}) {
  const label = thread.reason ? reasonText(thread.reason) : undefined
  return (
    <li className="flex flex-col items-start gap-1.5">
      <Bubble variant="default" align="end" className="max-w-[85%] self-end">
        <BubbleContent className="line-clamp-4 px-4 py-2.5 text-[15px] whitespace-pre-wrap">
          {thread.opener ?? thread.chat.title}
        </BubbleContent>
      </Bubble>
      <div className="mt-1.5 flex w-full max-w-[calc(85%+2.5rem)] items-end gap-2">
        <Bot id={botId} className="size-8 self-end" />
        <div
          className={cn(
            "flex min-h-14 min-w-0 flex-1 items-center gap-3 rounded-2xl border bg-card px-4 py-2",
            open && "border-foreground/20 bg-muted",
          )}
        >
          <StateIcon state={thread.state} />
          <span className="min-w-0 flex-1">
            <span className="block truncate">{thread.chat.title}</span>
            {label && <span className="block truncate text-xs text-warning">{label}</span>}
          </span>
        </div>
      </div>
      <Link
        to={`/c/${thread.chat.id}`}
        replace={beside}
        state={{ bot: profileId }}
        aria-current={open ? "page" : undefined}
        className="-mt-4 ml-10 flex min-h-11 items-center gap-1 rounded-full px-2 text-sm text-muted-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        <span className="font-medium text-info">View thread</span>
        {thread.replies > 0 && (
          <span>
            · {thread.replies} {thread.replies === 1 ? "reply" : "replies"}
          </span>
        )}
        <ChevronRightIcon className="size-4" />
      </Link>
    </li>
  )
}

/**
 * A bot as one chat (bot threads, experimental): every chat with it is a thread here, newest at the
 * bottom by the composer, which starts another. From `xl` the app shell keeps it beside the open
 * thread (`thread`), so picking another one swaps it in place.
 */
export function BotThreadsPage({
  profileId: paneId,
  thread: openThread,
}: {
  profileId?: string
  thread?: string
}) {
  const params = useParams()
  const profileId = paneId ?? params.profileId ?? ""
  const navigate = useNavigate()
  const { root } = useNav()
  const profile = useLiveQuery(async () => (await db.profiles.get(profileId)) ?? null, [profileId])
  const threads = useThreads(profileId)
  const now = useNow()
  const scroller = useRef<HTMLDivElement>(null)

  // Where a new chat goes, and where the app comes back to.
  useEffect(() => {
    if (profile) void setActiveProfile(profile.id)
  }, [profile])

  // An unknown or removed bot falls back to the active one.
  useEffect(() => {
    if (profile === null) root("/")
  }, [profile, root])

  // Opens at the newest thread, and follows a new one in.
  const count = threads?.length ?? 0
  useLayoutEffect(() => {
    const element = scroller.current
    if (element) element.scrollTop = element.scrollHeight
  }, [profileId, count])

  const configured = Boolean(profile?.baseUrl.trim())
  const start = async (text: string, attachments: Attachment[] = []) => {
    if (!profile) return
    try {
      const { id } = await createConversation(profile.id)
      navigate(`/c/${id}`, { replace: Boolean(openThread), state: { bot: profile.id } })
      await sendMessage(id, text, { attachments })
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
            aria-label="Bot options"
          />
        }
      >
        <EllipsisIcon />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="min-w-44">
        <DropdownMenuItem onClick={() => root("/settings/bots")}>
          <SettingsIcon />
          Bot settings
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  )

  return (
    <div className="relative flex min-h-0 flex-1 flex-col">
      <ChatHeader
        title={profile?.name ?? "Bot"}
        subtitle={count ? `${count} ${count === 1 ? "thread" : "threads"}` : undefined}
        botId={profile?.botId}
        actions={actions}
      />

      {threads === undefined ? (
        <div className="flex flex-1 items-center justify-center">
          <Spinner className="size-6" />
        </div>
      ) : count ? (
        <div ref={scroller} className="min-h-0 flex-1 overflow-y-auto">
          <ul className="mx-auto flex w-full max-w-3xl flex-col gap-5 px-4 pt-32 pb-6">
            {threads.map((thread, index) => {
              const day = dayOf(thread.chat.updatedAt, now)
              const newDay = index === 0 || dayOf(threads[index - 1].chat.updatedAt, now) !== day
              return (
                <Fragment key={thread.chat.id}>
                  {newDay && (
                    <li
                      aria-hidden
                      className="flex items-center gap-3 text-xs font-medium text-muted-foreground before:h-px before:flex-1 before:bg-border after:h-px after:flex-1 after:bg-border"
                    >
                      {day}
                    </li>
                  )}
                  <ThreadItem
                    thread={thread}
                    botId={profile?.botId}
                    profileId={profileId}
                    open={thread.chat.id === openThread}
                    beside={Boolean(openThread)}
                  />
                </Fragment>
              )
            })}
          </ul>
        </div>
      ) : (
        <div className="flex flex-1 flex-col items-center justify-center gap-6 px-4 pt-24 pb-8 text-center">
          <Bot id={profile?.botId} animate className="size-24" />
          <div className="space-y-1.5">
            <h1 className="text-2xl font-semibold tracking-tight">
              Hey, I'm {profile?.name ?? "Hermes"}
            </h1>
            <p className="max-w-sm text-sm text-muted-foreground">
              {configured
                ? "Ask me anything. I can run tools on your machine and I'll ask before doing anything risky."
                : "Point Memento at your Hermes Agent API server to start chatting."}
            </p>
          </div>
          {configured && (
            <div className="flex max-w-md flex-wrap justify-center gap-2">
              {SUGGESTIONS.map((text) => (
                <Button
                  key={text}
                  variant="outline"
                  className="h-auto min-h-10 rounded-full whitespace-normal"
                  onClick={() => void start(text).catch(() => {})}
                >
                  {text}
                </Button>
              ))}
            </div>
          )}
        </div>
      )}

      <div data-toast-above className="px-3 pb-[max(0.75rem,env(safe-area-inset-bottom))] sm:px-4">
        <Composer
          key={profileId}
          busy={false}
          disabled={!configured}
          onSend={start}
          onQueue={start}
          onStop={() => {}}
          onCommand={(command) => root(command === "new" ? `/b/${profileId}` : "/settings")}
          filesAvailable={Boolean(profile?.apiKey)}
          imagesAvailable={profile?.imageInput !== false}
          connection={{ baseUrl: profile?.baseUrl ?? "", apiKey: profile?.apiKey ?? "" }}
          botName={profile?.name}
        />
      </div>
    </div>
  )
}

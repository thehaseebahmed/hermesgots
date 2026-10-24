import { useEffect, useMemo, useRef, useState } from "react"
import { useLiveQuery } from "dexie-react-hooks"
import { useNavigate, useSearchParams } from "react-router"
import { toast } from "sonner"
import { ChevronDownIcon, LinkIcon, MessageCircleIcon, PlusIcon } from "lucide-react"

import { Banner } from "@/components/banner"
import { BotCard } from "@/components/bot-card"
import { AttachmentTile } from "@/components/chat/attachments"
import { Popup, PopupContent, PopupHeader, PopupTitle } from "@/components/popup"
import { Spinner } from "@/components/ui/spinner"
import { Textarea } from "@/components/ui/textarea"
import { isPhoto } from "@/lib/attachment-caps"
import { prepareIntake } from "@/lib/attachments"
import { queueMessage, sendMessage } from "@/lib/chat"
import {
  createConversation,
  db,
  getActiveProfile,
  listEnabledProfiles,
  setActiveProfile,
  type Attachment,
} from "@/lib/db"
import { formatRelative } from "@/lib/format"
import { reconcileHistory } from "@/lib/history"
import { useNav } from "@/lib/nav"
import { clearShare, readWebShare, shareText, useIncomingShare } from "@/lib/share"
import { useBotThreads, useNow } from "@/lib/threads"

/** How many of a bot's newest chats are offered before Show more. */
const FIRST = 5
const MORE = 30
/** No files at all, kept as one array so a share with nothing read yet doesn't rebuild on render. */
const NO_FILES: Attachment[] = []

function hostOf(link: string) {
  try {
    return new URL(link).hostname.replace(/^www\./, "")
  } catch {
    return link
  }
}

function SectionLabel({ children }: { children: string }) {
  return <h2 className="px-1 text-sm font-medium text-muted-foreground">{children}</h2>
}

/** Thumbnails of the shared files, each with a button that leaves it out. */
function SharedFiles({
  files,
  onRemove,
}: {
  files: Attachment[]
  onRemove: (attachment: Attachment) => void
}) {
  return (
    <ul className="-mx-6 flex gap-2.5 overflow-x-auto px-6 pt-2 pb-1 pl-7">
      {files.map((attachment) => (
        <li key={attachment.id} className="shrink-0">
          <AttachmentTile attachment={attachment} onRemove={() => onRemove(attachment)} />
        </li>
      ))}
    </ul>
  )
}

/**
 * What another app shared into Gots: add a note, pick the bot and a chat (or thread) of it, or a
 * new one, and send. The message goes like one typed in that chat, images as its attachments.
 */
export function SharePage() {
  const navigate = useNavigate()
  const { root, up } = useNav()
  const [params] = useSearchParams()
  const webId = params.get("id")
  const share = useIncomingShare()
  const [opening, setOpening] = useState(Boolean(webId))
  const botThreads = useBotThreads()
  const noun = botThreads ? "thread" : "chat"
  const now = useNow()

  // The installed PWA's share target lands here with the service worker's id for it.
  useEffect(() => {
    if (!webId) return
    let cancelled = false
    void readWebShare(webId).then(() => {
      if (cancelled) return
      setOpening(false)
      navigate("/share", { replace: true, state: { quiet: true } })
    })
    return () => {
      cancelled = true
    }
  }, [webId, navigate])

  // Set once the screen sends or closes, which clears the share on its way out.
  const leaving = useRef(false)
  const missing = !share && !opening && !webId
  useEffect(() => {
    if (missing && !leaving.current) root("/")
  }, [missing, root])

  const close = () => {
    leaving.current = true
    clearShare()
    up("/")
  }

  const bots = useLiveQuery(listEnabledProfiles, [])
  const active = useLiveQuery(async () => (await getActiveProfile())?.id ?? null, [])
  const [picked, setPicked] = useState<string>()
  const profile = bots?.find((bot) => bot.id === (picked ?? active)) ?? bots?.[0]
  const [showAll, setShowAll] = useState(false)
  const [note, setNote] = useState("")
  const [removed, setRemoved] = useState<string[]>([])
  const [read, setRead] = useState<{ share: string; files: Attachment[] } | undefined>(undefined)
  const readStarted = useRef<string | undefined>(undefined)
  const readHere = share && read?.share === share.id ? read : undefined
  const preparing = Boolean(share) && !readHere
  const prepared = readHere ? readHere.files : NO_FILES
  const files = useMemo(
    () => prepared.filter((attachment) => !removed.includes(attachment.id)),
    [prepared, removed],
  )
  // A photo is a photo whatever form it lands in: one a model can't take images from goes as a file.
  const photos = files.filter((attachment) => attachment.image || isPhoto(attachment.type))
  const [sending, setSending] = useState<string | false>(false)

  const [shareId, setShareId] = useState(share?.id)
  if (share && share.id !== shareId) {
    setShareId(share.id)
    setNote("")
    setRemoved([])
    setShowAll(false)
    setSending(false)
  }

  // Every file under the same caps a pick is held to, refused out loud where it doesn't fit.
  const imagesAvailable = profile?.imageInput !== false
  useEffect(() => {
    if (!share || !profile || readStarted.current === share.id) return
    readStarted.current = share.id
    let live = true
    void prepareIntake(share.files, { inline: imagesAvailable }).then(
      ({ attachments, refusals }) => {
        if (!live) return
        for (const refusal of [...share.refused, ...refusals]) toast.error(refusal.message)
        setRead({ share: share.id, files: attachments })
      },
    )
    return () => {
      live = false
    }
  }, [share, profile, imagesAvailable])

  const chats = useLiveQuery(async () => {
    if (!profile) return []
    return db.conversations
      .where("[profileId+updatedAt]")
      .between([profile.id, -Infinity], [profile.id, Infinity])
      .reverse()
      .filter((c) => !c.projectId && !c.discardedAt)
      .limit(MORE)
      .toArray()
  }, [profile?.id])
  const shown = showAll ? chats : chats?.slice(0, FIRST)

  const pickBot = (id: string) => {
    setPicked(id)
    setShowAll(false)
  }

  if (!share || !bots) {
    return (
      <div className="flex flex-1 items-center justify-center">
        <Spinner className="size-6" />
      </div>
    )
  }

  const configured = Boolean(profile?.baseUrl.trim())
  // Without the plugin a model that can't see images has no way to take them as files either.
  const imagesBlocked = photos.length > 0 && profile?.imageInput === false && !profile.apiKey
  const empty = !note.trim() && !share.text && !share.links.length && !files.length
  const canSend =
    Boolean(profile) && configured && !imagesBlocked && !empty && !sending && !preparing

  const send = async (target: string) => {
    if (!profile || !canSend) return
    setSending(target)
    try {
      const text = shareText(share, note)
      const attachments = files
      const existing = target !== "new" ? await db.conversations.get(target) : undefined
      // As the chat's own composer does, so the message follows another device's latest turn.
      if (existing)
        await Promise.race([
          reconcileHistory(existing.id).catch(() => undefined),
          new Promise((resolve) => setTimeout(resolve, 1500)),
        ])
      const id = existing?.id ?? (await createConversation(profile.id)).id
      const busy = existing
        ? (await db.messages
            .where("conversationId")
            .equals(existing.id)
            .filter((m) => m.status === "streaming")
            .count()) > 0
        : false
      void setActiveProfile(profile.id)
      leaving.current = true
      clearShare()
      root(`/c/${id}`)
      if (busy) await queueMessage(id, text, attachments)
      else await sendMessage(id, text, { attachments })
    } catch (error) {
      setSending(false)
      toast.error(error instanceof Error ? error.message : "Couldn't share that.")
    }
  }

  const option = (id: string, icon: React.ReactNode, title: string, subtitle?: string) => (
    <button
      key={id}
      type="button"
      disabled={!canSend}
      onClick={() => void send(id)}
      className="flex min-h-14 w-full items-center gap-4 bg-card px-5 py-3 text-left text-card-foreground outline-none hover:bg-muted focus-visible:bg-muted disabled:opacity-60"
    >
      {icon}
      <span className="flex min-w-0 flex-1 flex-col">
        <span className="truncate">{title}</span>
        {subtitle && <span className="truncate text-sm text-muted-foreground">{subtitle}</span>}
      </span>
      {sending === id && <Spinner className="size-5 shrink-0" />}
    </button>
  )

  return (
    <Popup open onOpenChange={(open) => !open && close()}>
      <PopupContent className="max-h-[90dvh]">
        <PopupHeader className="pb-2">
          <PopupTitle>Share</PopupTitle>
        </PopupHeader>
        <div className="flex flex-col gap-6 px-6 pt-2">
          <section className="flex flex-col gap-3">
            {files.length > 0 && (
              <SharedFiles
                files={files}
                onRemove={(attachment) => setRemoved((all) => [...all, attachment.id])}
              />
            )}
            {share.links.map((link) => (
              <div
                key={link}
                className="flex min-h-16 items-center gap-3 rounded-2xl bg-card px-4 py-3 ring-1 ring-foreground/10"
              >
                <span className="flex size-10 shrink-0 items-center justify-center rounded-xl bg-muted">
                  <LinkIcon className="size-5 text-muted-foreground" />
                </span>
                <span className="flex min-w-0 flex-1 flex-col">
                  <span className="truncate font-medium">
                    {share.links.length === 1 && share.title ? share.title : hostOf(link)}
                  </span>
                  <span className="truncate text-sm text-muted-foreground">{link}</span>
                </span>
              </div>
            ))}
            {share.text && (
              <blockquote className="line-clamp-6 rounded-2xl bg-muted/60 px-4 py-3 text-[15px] whitespace-pre-wrap">
                {share.text}
              </blockquote>
            )}
            <Textarea
              value={note}
              onChange={(event) => setNote(event.target.value)}
              placeholder="Add a note"
              aria-label="Note"
              className="min-h-20"
            />
          </section>

          <section className="flex flex-col gap-2">
            <SectionLabel>Send to</SectionLabel>
            <div
              role="radiogroup"
              aria-label="Bot"
              className="-mx-6 flex [scrollbar-width:none] gap-2 overflow-x-auto px-6 py-1 [&::-webkit-scrollbar]:hidden"
            >
              {bots.map((bot) => (
                <BotCard
                  key={bot.id}
                  botId={bot.botId}
                  name={bot.name}
                  selected={bot.id === profile?.id}
                  onClick={() => pickBot(bot.id)}
                />
              ))}
            </div>
            {imagesBlocked && <Banner>{profile?.name}'s model can't take images.</Banner>}
            {!configured && profile && <Banner>{profile.name} isn't set up yet.</Banner>}
          </section>

          <section className="flex flex-col gap-2">
            <SectionLabel>{botThreads ? "Thread" : "Chat"}</SectionLabel>
            <div
              aria-label={noun}
              className="flex flex-col gap-px overflow-hidden rounded-3xl bg-border ring-1 ring-foreground/10"
            >
              {option(
                "new",
                <span className="flex size-9 shrink-0 items-center justify-center rounded-xl bg-primary text-primary-foreground">
                  <PlusIcon className="size-5" />
                </span>,
                `New ${noun}`,
              )}
              {shown?.map((chat) =>
                option(
                  chat.id,
                  <span className="flex size-9 shrink-0 items-center justify-center rounded-xl bg-muted">
                    <MessageCircleIcon className="size-5 text-muted-foreground" />
                  </span>,
                  chat.title,
                  formatRelative(chat.updatedAt, now),
                ),
              )}
              {!showAll && (chats?.length ?? 0) > FIRST && (
                <button
                  type="button"
                  onClick={() => setShowAll(true)}
                  className="flex min-h-12 w-full items-center justify-center gap-1.5 bg-card text-sm font-medium text-muted-foreground outline-none focus-visible:bg-muted"
                >
                  Show more
                  <ChevronDownIcon className="size-4" />
                </button>
              )}
            </div>
          </section>
        </div>
      </PopupContent>
    </Popup>
  )
}

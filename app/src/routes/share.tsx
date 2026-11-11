import { useEffect, useMemo, useRef, useState } from "react"
import { useLiveQuery } from "dexie-react-hooks"
import { useNavigate, useSearchParams } from "react-router"
import { toast } from "sonner"
import { ChevronDownIcon, CodeXmlIcon, LinkIcon, MessageCircleIcon, PlusIcon } from "lucide-react"

import { Banner } from "@/components/banner"
import { BotCard } from "@/components/bot-card"
import { AttachmentTile } from "@/components/chat/attachments"
import { SearchField } from "@/components/item-list"
import { Popup, PopupContent, PopupHeader, PopupTitle } from "@/components/popup"
import { Spinner } from "@/components/ui/spinner"
import { Textarea } from "@/components/ui/textarea"
import { isPhoto } from "@/lib/attachment-caps"
import { prepareIntake } from "@/lib/attachments"
import { queueMessage, sendMessage } from "@/lib/chat"
import {
  conversationsOf,
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
import { recentTargets, searchTargets, SHARE_FIRST, type ShareTarget } from "@/lib/share-list"
import { beginChat, useNow } from "@/lib/threads"

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
 * What another app shared into Gots: add a note, pick the bot and a chat of it, or a new one, and
 * send. The message goes like one typed in that chat, images as its attachments.
 */
export function SharePage() {
  const navigate = useNavigate()
  const { root, up } = useNav()
  const [params] = useSearchParams()
  const webId = params.get("id")
  const share = useIncomingShare()
  const [opening, setOpening] = useState(Boolean(webId))
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
  const [query, setQuery] = useState("")
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
    setQuery("")
    setSending(false)
  }

  // Every file under the same caps a pick is held to, refused out loud where it doesn't fit.
  const imagesAvailable = profile?.imageInput !== false
  useEffect(() => {
    if (!share || !profile || readStarted.current === share.id) return
    readStarted.current = share.id
    let live = true
    void prepareIntake(share.files, {
      readsImages: imagesAvailable,
      route: "yes",
    }).then(({ attachments, refusals }) => {
      if (!live) return
      for (const refusal of [...share.refused, ...refusals]) toast.error(refusal.message)
      setRead({ share: share.id, files: attachments })
    })
    return () => {
      live = false
    }
  }, [share, profile, imagesAvailable])

  // The picked bot's conversations, newest first off the clock a row is placed by. What the sheet
  // offers is the rule's to decide, so this read narrows nothing.
  const conversations = useLiveQuery(async () => {
    if (!profile) return []
    return conversationsOf(profile.id).toArray()
  }, [profile?.id])
  const targets = useMemo(
    () => (conversations ? recentTargets(conversations, now) : undefined),
    [conversations, now],
  )
  // A query is the search's, and it draws every match: the ten rows and the window's twenty-five are
  // what the field leads out of, not its edge. A blank field is no query at all, so the window is
  // drawn again with its Show more.
  const searching = Boolean(query.trim())
  const matches = useMemo(
    () => (searching && conversations ? searchTargets(conversations, query) : undefined),
    [conversations, query, searching],
  )
  const shown = matches ?? (showAll ? targets : targets?.slice(0, SHARE_FIRST))

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
      const chat = existing ?? (await beginChat(profile.id))
      const id = chat.id
      // A chat is asked what any chat is: a turn still streaming there means the note waits in the
      // queue rather than being dropped by a second send. Read through the `status` index, so the
      // check costs the one running row rather than every message the chat holds.
      const busy = Boolean(
        await db.messages.where("[conversationId+status]").equals([id, "streaming"]).first(),
      )
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

  /** The tile a row leads with: Code's mark for a session, a chat's own bubble for a chat. */
  const mark = (kind: ShareTarget["kind"]) => (
    <span className="flex size-9 shrink-0 items-center justify-center rounded-xl bg-muted">
      {kind === "session" ? (
        <CodeXmlIcon className="size-5 text-muted-foreground" />
      ) : (
        <MessageCircleIcon className="size-5 text-muted-foreground" />
      )}
    </span>
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
            <SectionLabel>Recent</SectionLabel>
            <div
              aria-label="Recent"
              className="flex flex-col gap-px overflow-hidden rounded-3xl bg-border ring-1 ring-foreground/10"
            >
              {option(
                "new",
                <span className="flex size-9 shrink-0 items-center justify-center rounded-xl bg-primary text-primary-foreground">
                  <PlusIcon className="size-5" />
                </span>,
                "New chat",
              )}
              {shown?.map((target) =>
                option(target.id, mark(target.kind), target.title, formatRelative(target.at, now)),
              )}
              {!searching && !showAll && (targets?.length ?? 0) > SHARE_FIRST && (
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
            {searching && shown?.length === 0 && (
              <p className="px-1 text-sm text-muted-foreground">Nothing matches.</p>
            )}
          </section>
        </div>
        {/*
          The search at the foot. The sheet's content is its scroller, so this stays on screen while
          the rows pass under it, and `mt-auto` keeps it at the foot of a sheet taller than the list.
          The pop-up already reserves the phone's safe area below the scroller, so this adds only its
          own breathing room.
        */}
        <div
          data-slot="share-search"
          className="sticky bottom-0 z-10 mt-auto shrink-0 bg-popover px-6 pt-4 pb-3"
        >
          <SearchField value={query} onChange={setQuery} label="Search chats and sessions" />
        </div>
      </PopupContent>
    </Popup>
  )
}

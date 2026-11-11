import { useEffect, useMemo, useRef, useState } from "react"
import { useLiveQuery } from "dexie-react-hooks"
import { useNavigate, useSearchParams } from "react-router"
import { toast } from "sonner"
import { ChevronDownIcon, CodeXmlIcon, LinkIcon, MessageCircleIcon, PlusIcon } from "lucide-react"

import { Banner } from "@/components/banner"
import { BotPicker } from "@/components/chat/bot-picker"
import { AttachmentTile } from "@/components/chat/attachments"
import { SearchField } from "@/components/item-list"
import { Popup, PopupContent, PopupHeader, PopupTitle } from "@/components/popup"
import { RoomFaces } from "@/components/room/room-faces"
import { Spinner } from "@/components/ui/spinner"
import { Textarea } from "@/components/ui/textarea"
import { ROOM_MAX_ATTACHMENTS, carriedFiles, isPhoto, roomRefusal } from "@/lib/attachment-caps"
import { prepareIntake } from "@/lib/attachments"
import { queueMessage, sendMessage } from "@/lib/chat"
import { serverConfig } from "@/lib/connection"
import {
  conversationsOf,
  db,
  listEnabledProfiles,
  setActiveProfile,
  type Attachment,
  type Profile,
  type RoomAttachment,
} from "@/lib/db"
import { formatRelative } from "@/lib/format"
import { sendRoomMessage, uploadRoomAttachment } from "@/lib/hermes"
import { reconcileHistory } from "@/lib/history"
import { useNav } from "@/lib/nav"
import { useRoomNeeds } from "@/lib/room"
import { clearShare, readWebShare, shareText, useIncomingShare } from "@/lib/share"
import {
  recentTargets,
  searchTargets,
  SHARE_FIRST,
  type ShareKind,
  type ShareTarget,
} from "@/lib/share-list"
import { beginChat, useNow } from "@/lib/threads"
import { randomId } from "@/lib/utils"

/** No files at all, kept as one array so a share with nothing read yet doesn't rebuild on render. */
const NO_FILES: Attachment[] = []

function hostOf(link: string) {
  try {
    return new URL(link).hostname.replace(/^www\./, "")
  } catch {
    return link
  }
}

/**
 * What a room send that failed minted: the message it was a tap for, the Host's event id, and per
 * file its upload id with the manifest the Host answered. A tap made again while the share is
 * unchanged reuses all three, as the room's own composer does (`failed` in `lib/room.ts`), so one
 * message lands and a file the store already holds is not bought twice — the store is idempotent on
 * an upload id, but every byte re-sent is still the wire's.
 */
type Minted = {
  key: string
  eventId: string
  uploads: Map<string, { uploadId: string; manifest?: RoomAttachment }>
}

function SectionLabel({ children }: { children: string }) {
  return <h2 className="px-1 text-sm font-medium text-muted-foreground">{children}</h2>
}

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
 * The share sheet: what arrived, a note to go with it, and the rows it can go to — the picked bot's
 * chats and code sessions of the week, and the rooms whose roster seats that bot. A chat's or a
 * session's row sends a turn into it, while a room's sends through the room's own store, as a message
 * typed in the room does, because a room is the Host's log rather than a chat's thread.
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
  /** The room send the last tap left unmade, if it did. */
  const failed = useRef<Minted | undefined>(undefined)
  const missing = !share && !opening && !webId
  useEffect(() => {
    if (missing && !leaving.current) root("/")
  }, [missing, root])

  const close = () => {
    leaving.current = true
    clearShare()
    up("/")
  }

  const answering = useLiveQuery(listEnabledProfiles, [])
  // The bots by name, as the picker lists them, and the first of them the sheet starts on: a share
  // has no bot of its own, and the one it arrived at is whichever bot was last talked to.
  const bots = useMemo(
    () => [...(answering ?? [])].sort((a, b) => a.name.localeCompare(b.name)),
    [answering],
  )
  const [picked, setPicked] = useState<string>()
  const profile = bots.find((bot) => bot.id === picked) ?? bots[0]
  const [showAll, setShowAll] = useState(false)
  const [query, setQuery] = useState("")
  // The sender's own text opens the note: it is the message's words, and the sheet's one field for them.
  const [note, setNote] = useState(share?.text ?? "")
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
    setNote(share.text ?? "")
    setRemoved([])
    setShowAll(false)
    setQuery("")
    setSending(false)
  }

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

  // What the sheet offers, and in what order, is the rule's to decide, so this read narrows nothing.
  // It answers with the bot it read for: `useLiveQuery` keeps its last answer on screen while the
  // next read is out, and a pick made in that beat would draw one bot's chats beside another bot's
  // rooms — a row a tap sends into under the name of the bot the sheet says it is going to.
  const chats = useLiveQuery(async () => {
    if (!profile) return undefined
    return { of: profile.id, rows: await conversationsOf(profile.id).toArray() }
  }, [profile?.id])
  const conversations = chats && profile && chats.of === profile.id ? chats.rows : undefined
  // The rooms this device lists, and the ones the picked bot's roster seats: a room's row is the room
  // list's rather than the read above's, so the sheet draws it once (ADR 0115). A room no bot of this
  // device answers for seats nobody, and is no list's row.
  const roomNeeds = useRoomNeeds()
  const rooms = useMemo(
    () =>
      profile
        ? (roomNeeds ?? [])
            .filter((room) => room.seated.includes(profile.id))
            .map((room) => ({
              id: room.chat.id,
              title: room.chat.title,
              updatedAt: room.chat.updatedAt,
              faces: room.faces,
            }))
        : [],
    [roomNeeds, profile],
  )
  const targets = useMemo(
    () => (conversations ? recentTargets(conversations, now, rooms) : undefined),
    [conversations, now, rooms],
  )
  const searching = Boolean(query.trim())
  const matches = useMemo(
    () => (searching && conversations ? searchTargets(conversations, query, rooms) : undefined),
    [conversations, query, searching, rooms],
  )
  const shown = matches ?? (showAll ? targets : targets?.slice(0, SHARE_FIRST))
  // Both lists are what a query is answered from, so a sheet with one of them out has not answered a
  // query at all: "Nothing matches." over a room that is a beat away is a lie about a row to come.
  const answered = Boolean(conversations && roomNeeds)

  const pickBot = (id: string) => {
    setPicked(id)
    setShowAll(false)
  }

  if (!share || !answering) {
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

  const handed = (id: string, bot: string) => {
    void setActiveProfile(bot)
    leaving.current = true
    clearShare()
    root(`/c/${id}`)
  }

  const couldNot = (error: unknown) => {
    setSending(false)
    toast.error(error instanceof Error ? error.message : "Couldn't share that.")
  }

  /**
   * One message into a room, the way the room's own composer sends one: every file to the Host's room
   * store under an upload id minted here, then the note as one event under an id minted here (ADR
   * 0116). A room is not a chat, so nothing catches up, nothing queues and no chat is made: the Host
   * appends the message and its members answer it.
   *
   * The Host takes eight files to a message, so a bigger share is refused here in the room's own
   * number rather than half sent — and refused only here, since a chat takes the same share whole.
   */
  const sendIntoRoom = async (id: string, bot: Profile) => {
    // The row a tap was drawn from can be a beat behind the device, so the room is looked up again
    // before anything is sent: a record that has gone is no room of this sheet any more, and the tap
    // says so rather than posting into a room the sheet isn't offering.
    const held = await db.conversations.get(id)
    if (!held?.room) {
      toast.error("That room isn't on the sheet any more.")
      return
    }
    const carried = carriedFiles(files)
    if (carried.length > ROOM_MAX_ATTACHMENTS) {
      toast.error(roomRefusal(carried.length).message)
      return
    }
    setSending(id)
    try {
      const config = serverConfig(bot)
      const words = shareText(share, note)
      // What the Host binds is the message rather than the tap: this share, sent into this room with
      // these words and these files, is the one the last attempt minted ids for, and anything else —
      // another share, another room, a note or a file the reader changed — is a new message.
      const key = [share.id, id, words, ...carried.map((file) => file.id)].join("\u0000")
      const reused = failed.current?.key === key ? failed.current : undefined
      const eventId = reused?.eventId ?? randomId()
      const uploads =
        reused?.uploads ?? new Map<string, { uploadId: string; manifest?: RoomAttachment }>()
      failed.current = { key, eventId, uploads }
      const manifests = await Promise.all(
        carried.map(async (file) => {
          const kept = uploads.get(file.id)
          // A file the Host has answered for is named by its manifest: this retry sends the message
          // those bytes were stored for, so sending them again would buy nothing.
          if (kept?.manifest) return kept.manifest
          // The id is kept before the upload, so a retry after a lost answer stores the file once.
          const uploadId = kept?.uploadId ?? randomId()
          uploads.set(file.id, { uploadId })
          const manifest = await uploadRoomAttachment(
            config,
            id,
            { name: file.name, type: file.type, blob: file.blob },
            uploadId,
          )
          uploads.set(file.id, { uploadId, manifest })
          return manifest
        }),
      )
      await sendRoomMessage(config, id, eventId, words, manifests)
      failed.current = undefined
      // The reader can shut the sheet while the note is out, and a screen that has gone neither takes
      // them into the room nor says a word to nobody.
      if (leaving.current) return
      handed(id, bot.id)
    } catch (error) {
      if (leaving.current) return
      couldNot(error)
    }
  }

  const send = async (target: string, kind: ShareKind | "new") => {
    if (!profile || !canSend) return
    if (kind === "room") return sendIntoRoom(target, profile)
    setSending(target)
    // Set once this tap has taken the reader into the chat: a note that fails from then on is said on
    // the screen they are on, while one that fails before it is the sheet's, and goes unsaid where the
    // sheet has gone.
    let handedOver = false
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
      // As the room's path does: the reader can shut the sheet while the chat catches up, and a screen
      // that has gone does not take them into the chat afterwards.
      if (leaving.current) return
      handed(id, profile.id)
      handedOver = true
      if (busy) await queueMessage(id, text, attachments)
      else await sendMessage(id, text, { attachments })
    } catch (error) {
      if (!handedOver && leaving.current) return
      couldNot(error)
    }
  }

  const option = (row: {
    id: string
    icon: React.ReactNode
    title: string
    subtitle?: string
    kind: ShareKind | "new"
  }) => (
    <button
      key={row.id}
      type="button"
      disabled={!canSend}
      onClick={() => void send(row.id, row.kind)}
      className="flex min-h-14 w-full items-center gap-4 bg-card px-5 py-3 text-left text-card-foreground outline-none hover:bg-muted focus-visible:bg-muted disabled:opacity-60"
    >
      {row.icon}
      <span className="flex min-w-0 flex-1 flex-col">
        <span className="truncate">{row.title}</span>
        {row.subtitle && (
          <span className="truncate text-sm text-muted-foreground">{row.subtitle}</span>
        )}
      </span>
      {sending === row.id && <Spinner className="size-5 shrink-0" />}
    </button>
  )

  /**
   * A row's mark: a room wears its members' faces where a chat or a session wears its icon, the
   * cluster being the app's own mark for a room wherever one is drawn (ADR 0126).
   */
  const mark = (target: ShareTarget) =>
    target.kind === "room" ? (
      <RoomFaces shown={target.faces.shown} more={target.faces.more} />
    ) : (
      <span className="flex size-9 shrink-0 items-center justify-center rounded-xl bg-muted">
        {target.kind === "session" ? (
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
            <Textarea
              value={note}
              onChange={(event) => setNote(event.target.value)}
              placeholder="Add a note"
              aria-label="Note"
              className="min-h-20"
            />
          </section>

          <section className="flex flex-col gap-2">
            {/* A query replaces the week with what it matches, so the heading says which list this is. */}
            <SectionLabel>{searching ? "Search Results" : "Recent"}</SectionLabel>
            {profile && <BotPicker profile={profile} onPick={(bot) => pickBot(bot.id)} />}
            {imagesBlocked && <Banner>{profile?.name}'s model can't take images.</Banner>}
            {!configured && profile && <Banner>{profile.name} isn't set up yet.</Banner>}
            <div
              aria-label={searching ? "Search Results" : "Recent"}
              className="flex flex-col gap-px overflow-hidden rounded-3xl bg-border ring-1 ring-foreground/10"
            >
              {option({
                id: "new",
                icon: (
                  <span className="flex size-9 shrink-0 items-center justify-center rounded-xl bg-primary text-primary-foreground">
                    <PlusIcon className="size-5" />
                  </span>
                ),
                title: "New chat",
                kind: "new",
              })}
              {shown?.map((target) =>
                option({
                  id: target.id,
                  icon: mark(target),
                  title: target.title,
                  subtitle: formatRelative(target.at, now),
                  kind: target.kind,
                }),
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
            {searching && answered && shown?.length === 0 && (
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
          <SearchField value={query} onChange={setQuery} label="Search chats, sessions and rooms" />
        </div>
      </PopupContent>
    </Popup>
  )
}

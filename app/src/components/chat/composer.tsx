import {
  useEffect,
  useId,
  useRef,
  useState,
  type ClipboardEvent,
  type DragEvent,
  type FormEvent,
  type KeyboardEvent,
  type PointerEvent,
  type ReactNode,
} from "react"
import { ArrowUpIcon, MicIcon, SquareIcon } from "lucide-react"
import { toast } from "sonner"

import { AttachMenu } from "@/components/chat/attach-menu"
import { PointChip, useCanvasPoints } from "@/components/chat/canvas-points"
import { useCodeFace } from "@/components/chat/code-face"
import { AttachmentTile } from "@/components/chat/attachments"
import type { ModeSettings } from "@/components/chat/mode-menu"
import { usePreviewer, type PreviewItem } from "@/components/chat/previewer"
import { SlashMenu } from "@/components/chat/slash-menu"
import { VoiceBar } from "@/components/chat/voice-bar"
import { Spinner } from "@/components/ui/spinner"
import {
  InputGroup,
  InputGroupAddon,
  InputGroupButton,
  InputGroupTextarea,
} from "@/components/ui/input-group"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import { fresh, MAX_ATTACHMENTS } from "@/lib/attachment-caps"
import { AGENT_WORK_MS } from "@/lib/freshness"
import { openAttachment, prepareIntake } from "@/lib/attachments"
import { attachmentUrl, drawable } from "@/lib/attachment-url"
import { drawnCell, mediaKind } from "@/lib/media-kind"
import { previewItem } from "@/lib/media-items"
import type { Attachment } from "@/lib/db"
import { pointText, type CanvasPoint } from "@/lib/point-marker"
import type { PluginFeatureAnswer } from "@/lib/features"

import { flushDrafts, loadDraft, saveDraft, saveDraftToChat, useDraftText } from "@/lib/drafts"
import { quietly } from "@/lib/report"
import { AttachmentError } from "@/lib/send-turn"
import { tell } from "@/lib/tell"
import type { HermesConfig } from "@/lib/hermes"
import { COLUMN_BOX } from "@/lib/layout"
import {
  canRecord,
  joinText,
  keyboardClick,
  useChunkedDictation,
  useDictationInfo,
  type DictationAvailability,
} from "@/lib/dictation"
import { waitInserted, type TakeId } from "@/lib/dictation-wait"
import { writeDictation } from "@/lib/dictations"
import {
  SEND_COMMANDS,
  carriesMessage,
  isSendMode,
  localCommand,
  localCommands,
  optionId,
  pickItem,
  pickSendMode,
  rankSlashItems,
  sendMode,
  slashToken,
  type LocalCommand,
  type SlashItem,
} from "@/lib/slash"
import { enterSends, isDoubleEscape, isInterrupt, isSendChord } from "@/lib/keys"
import { useSkills } from "@/lib/skills"
import { midReply, steerAsked } from "@/lib/steer"
import { runnableSkills } from "@/lib/skills-cache"
import { useStartCommandFor } from "@/lib/threads"
import { cn, randomId } from "@/lib/utils"

const HOLD_MS = 400
const SLIDE_CANCEL_PX = 80
/**
 * How long a press answers for while something is still at work: long enough for a cooperative stop
 * to reach the child's boundary and show it, after which Stop comes back so a stop that never landed
 * can be asked for again (ADR 0085).
 */
const STOP_ASKED_MS = 15_000
/**
 * How long a press answers for once nothing looks to be at work: one read of the session's children,
 * because a quiet reading taken before the press's own stop has landed — or an older one still in
 * flight — is not the answer, and a child that keeps working until its boundary is.
 */
const STOP_SETTLED_MS = AGENT_WORK_MS

/**
 * Whether the Previewer is what a tap on a staged attachment opens: a file it can draw — a photo, a
 * clip, a recording — whose bytes this device has, since a photo it can't decode is handed to the
 * platform like a document is.
 */
const canPreview = (attachment: Attachment) =>
  drawnCell(attachment.type, attachment.name) !== "file" &&
  (!attachment.image || drawable(attachment))

export function Composer({
  busy,
  subagentsRunning = 0,
  disabled,
  onSend,
  onQueue,
  onStop,
  runId,
  onCommand,
  connection,
  botName = "Hermes",
  dictationHint,
  dictationWords,
  model,
  session,
  filesFeature,
  imagesAvailable,
  draftKey,
  onDraft,
  steerByDefault = false,
  sendOnEnter = false,
  canSteer = false,
  onSteer,
  notice,
  main = false,
  botChat = true,
  plain = false,
  files = !plain,
  maxAttachments,
  placeholder,
}: {
  busy: boolean
  /** Whether a message sent while a reply runs steers it unless it starts with `/queue`. */
  steerByDefault?: boolean
  /**
   * Whether Enter sends. The device's own switch (Settings > Appearance), off by default: while it
   * is off Enter starts a new line, and Ctrl+Enter sends (`enterSends` in `lib/keys.ts`).
   */
  sendOnEnter?: boolean
  /** Whether the running reply can be steered. */
  canSteer?: boolean
  /** Sends text to the running reply now (`/steer`), with what it carries. */
  onSteer?: (text: string, attachments: Attachment[]) => Promise<void> | void
  /** Where the unsent text is kept (`draftKey` in `lib/drafts.ts`), so it's there on return. */
  draftKey?: string
  /** Called with the text as it changes. */
  onDraft?: (text: string) => void
  /** The chat's Hermes profile, for the skills in the `/` menu. */
  connection: HermesConfig
  botName?: string
  /** Names the chat may mention (its title, a project's repos), to help the host hear them. */
  dictationHint?: string
  /** The bot's vocabulary: the names and words its dictation is written with. */
  dictationWords?: string[]
  /** The model pill, beside the `+` button. */
  model?: ReactNode
  /** A project session: its permission mode, picked in the `+` menu. */
  session?: ModeSettings
  filesFeature: PluginFeatureAnswer
  /** False when the model doesn't take images. */
  imagesAvailable: boolean
  /**
   * What the account behind this chat has to say about sending: the limit notice, on the box's own
   * top edge above the text. Absent where a card holds the composer's place.
   */
  notice?: ReactNode
  disabled?: boolean
  main?: boolean
  /** A bot's chat: Main or one of its threads. `false` for a project session, a canvas or a room. */
  botChat?: boolean
  onSend: (text: string, attachments: Attachment[]) => Promise<void> | void
  /** Called instead of `onSend` while a reply is streaming: a send queues the message. */
  onQueue: (text: string, attachments: Attachment[]) => Promise<void> | void
  /**
   * Asks for the session's stop, and answers whether the host took any of it. `false` — or a refused
   * promise — says nothing the press asked for is being carried out, so the press is not acknowledged
   * and the button stays the reader's to press.
   */
  onStop: () => boolean | void | Promise<boolean>
  /** The run this composer's Stop is for: the acknowledgement stands only while it is the same one. */
  runId?: string
  /** How many subagents the session has at work: with the turn over, Stop is still the session's. */
  subagentsRunning?: number
  onCommand?: (
    command: LocalCommand,
    message?: { text: string; attachments: Attachment[] },
  ) => Promise<void> | void
  /**
   * A surface with no `/` menu and no local command carried out — a room's composer, which appends
   * one message rather than driving a session. It no longer decides whether files land: `files` does,
   * so a plain surface that has a place to put them still takes them.
   */
  plain?: boolean
  /**
   * Whether this composer takes files — a picked one, a pasted one, a dropped one — and offers the
   * `+` menu they come from. Absent, it follows `plain`: a words-only surface takes none, and a chat
   * takes files (its `filesFeature` and `imagesAvailable` decide which, and why a file can't land).
   * A room names it on its own, since files go where its Host stores them and words go to its log.
   */
  files?: boolean
  /**
   * The most this surface takes, where it isn't a chat's ten: a room's Host caps a message at eight,
   * and a ninth file is refused here rather than by the Host once every file had gone up.
   */
  maxAttachments?: number
  /** The field's placeholder; a chat's is `Message <bot>…`. */
  placeholder?: string
}) {
  const [value, setValue] = useState("")
  const [attachments, setAttachments] = useState<Attachment[]>([])
  /**
   * The elements of the canvas's page this message points at, and whether the page is waiting for a tap.
   * A point is a chip the message carries, as an attachment is: it goes with the send that takes it,
   * and a send the host never took hands it back.
   */
  const [points, setPoints] = useState<CanvasPoint[]>([])
  const [pointing, setPointing] = useState(false)
  const pointAt = useCanvasPoints()
  /**
   * The staged files the Host refused, each with its own sentence: a tile the user can take off,
   * rather than a message the whole of which was refused with no word about which file it was. A
   * send that keeps a refused file says it again, because the Host is asked again.
   */
  const [refused, setRefused] = useState<Record<string, string>>({})
  // Picked files still being read, shown as placeholders where they'll land.
  const [preparing, setPreparing] = useState<{ id: string; name: string; image: boolean }[]>([])
  // Files taken moments ago, so a paste and the drop it can also fire add one copy.
  const recent = useRef(new Map<string, number>())
  // A file dragged over the composer, held until it is dropped or leaves.
  const [over, setOver] = useState(false)
  const { open: previewer, update: refresh } = usePreviewer()
  const owner = useId()
  // The key whose draft the text is; until it has loaded nothing is saved over it.
  const [loaded, setLoaded] = useState<string>()
  const stored = useRef("")
  // Another chat in the same composer starts from its own text, not this one's.
  const [shownKey, setShownKey] = useState(draftKey)
  if (shownKey !== draftKey) {
    setShownKey(draftKey)
    setLoaded(undefined)
    setValue("")
    setAttachments([])
    // A point is the canvas's page, not this chat's: another chat is another place to point at.
    setPoints([])
    setPointing(false)
  }
  // A draft that lands after mount fills the field only while it is still empty and untouched.
  const syncedDraft = useDraftText(draftKey)
  useEffect(() => {
    if (!draftKey || !syncedDraft || loaded !== draftKey) return
    if (stored.current || value) return
    stored.current = syncedDraft
    setValue(syncedDraft)
  }, [syncedDraft, draftKey, loaded, value])
  useEffect(() => {
    if (!draftKey) return
    let live = true
    void loadDraft(draftKey).then((text) => {
      if (!live) return
      stored.current = text
      setValue((current) => current || text)
      setLoaded(draftKey)
    })
    return () => {
      live = false
      // The composer is going, by whatever route: the text is written down here, and a chat already
      // kept as a draft takes it — so leaving by the sidebar or an address saves it, while an empty
      // field leaves that record alone (a send of its own is what retires it).
      void flushDrafts()
        .then(async () => {
          if (!draftKey?.startsWith("c:")) return
          if ((await loadDraft(draftKey)).trim()) await saveDraftToChat(draftKey.slice(2))
        })
        .catch(quietly("Keeping a session's draft"))
    }
  }, [draftKey])
  useEffect(() => {
    if (!draftKey || loaded !== draftKey || value === stored.current) return
    stored.current = value
    saveDraft(draftKey, value)
  }, [value, draftKey, loaded])
  useEffect(() => onDraft?.(value), [value, onDraft])
  // The token whose menu the user closed with Escape: it stays shut until the text changes.
  const [dismissed, setDismissed] = useState(false)
  const [active, setActive] = useState(0)
  // Where the caret is, so the `/` menu follows it rather than the whole field.
  const [caret, setCaret] = useState(0)
  // Where a pick wants the caret, placed once the new text is in the field.
  const caretWanted = useRef<number | null>(null)
  const textarea = useRef<HTMLTextAreaElement>(null)
  const face = useCodeFace()
  // When the last Escape that had nothing else to close was pressed, for the double that clears.
  const lastEscape = useRef<number | null>(null)
  const listId = useId()
  const dictationInfo = useDictationInfo(connection)
  const placeLanded = useRef<(landed: string, takeId: TakeId) => void>(() => {})
  const dictation = useChunkedDictation(
    connection,
    joinText(botName, dictationHint ?? ""),
    draftKey,
    dictationWords,
    (take, takeId) => {
      placeLanded.current(take.text, takeId)
      void writeDictation(connection, take)
    },
  )
  const canDictate = dictationInfo?.status === "ready" && canRecord()
  // Where the cursor was when dictation started, and whether the clip goes into the text or is sent.
  const dictationAt = useRef<number | null>(null)
  const dictationSends = useRef(false)
  // A press held past HOLD_MS is push-to-talk: letting go finishes, sliding away cancels.
  const press = useRef<{ x: number; y: number } | null>(null)
  const midRoute = (raw: string, carrying: Attachment[]) =>
    midReply(carrying, {
      steer: steerAsked(sendMode(raw)?.mode, { byDefault: steerByDefault, steerable: canSteer }),
      running: busy,
    })
  const steersNow = (raw: string, carrying: Attachment[]) =>
    Boolean(onSteer) && midRoute(raw, carrying) === "steer"

  // A press arms the page, and the tap that answers it is the chip it lands as: the page is let go
  // then, or when the reader presses again or leaves the composer.
  useEffect(() => {
    if (!pointAt || !pointing || disabled) return
    return pointAt.listen((picked) => {
      setPoints((held) => [...held, picked])
      setPointing(false)
    })
  }, [pointAt, pointing, disabled])

  const canSend =
    (value.trim().length > 0 || attachments.length > 0 || points.length > 0) &&
    !disabled &&
    preparing.length === 0
  const steering = steersNow(value, attachments)
  // One press stops everything the session has going, so Send's place is Stop while either works.
  const working = busy || subagentsRunning > 0
  // The press is answered while the run it was made for is this button's job and something is still
  // at work (ADR 0085).
  const [stopAsked, setStopAsked] = useState(false)
  const askedFor = useRef<string | undefined>(undefined)
  /** The latest the press answers for: fifteen seconds from the press, shortened by a quiet reading. */
  const answeredBy = useRef(0)
  const pressStop = () => {
    if (stopAsked) return
    askedFor.current = runId
    answeredBy.current = Date.now() + STOP_ASKED_MS
    setStopAsked(true)
    // The host's answer is what ends a press that asked for nothing — a stop it refused, or a session
    // whose children it had already let go (ADR 0085).
    void Promise.resolve(onStop()).then((asked) => {
      if (asked === false) setStopAsked(false)
    })
  }
  useEffect(() => {
    if (!stopAsked) return
    // A different run is the button's job now; a run that simply ended is not another one.
    if (runId !== undefined && runId !== askedFor.current) {
      setStopAsked(false)
      return
    }
    // Nothing at work is believed only after a read of the children could have said otherwise — and
    // only ever believed earlier, never later: a read that began before the press can land after it,
    // and re-arming on that stale "still running" pinned the button for another fifteen seconds.
    const now = Date.now()
    if (!working) answeredBy.current = Math.min(answeredBy.current, now + STOP_SETTLED_MS)
    const timer = window.setTimeout(
      () => setStopAsked(false),
      Math.max(0, answeredBy.current - now),
    )
    return () => window.clearTimeout(timer)
  }, [stopAsked, runId, working])

  // The menu follows the caret: a `/` that begins a word opens it, wherever in the message it is.
  const token = slashToken(value, caret)
  const skills = useSkills(connection, !plain && Boolean(token) && !disabled)
  const skillItems: SlashItem[] =
    skills.status === "ok"
      ? runnableSkills(skills.skills).map((skill) => ({ kind: "skill", ...skill }))
      : []
  const startable = useStartCommandFor(main, botChat)
  const items =
    plain || !token
      ? []
      : rankSlashItems(
          [...localCommands(startable), ...(busy ? SEND_COMMANDS : []), ...skillItems],
          token,
        )
  // Escape closes the menu until the text changes: any edit opens it again, and so does a new `/`.
  const menuOpen =
    !plain &&
    token !== null &&
    !dismissed &&
    !disabled &&
    (items.length > 0 || skills.status !== "ok")
  const activeIndex = Math.min(active, Math.max(items.length - 1, 0))
  // The caret follows the field. A pick places it (`caretWanted`); anything else that writes the
  // value — a restored draft, dictation, a message handed back after a failed send — leaves it
  // where the field put it, so the menu tracks the text the user is in and not where the mirror
  // last saw them (a draft opening with `/` must not offer to clear itself).
  useEffect(() => {
    const field = textarea.current
    if (!field || field.value !== value) return
    const wanted = caretWanted.current
    caretWanted.current = null
    if (wanted !== null) {
      field.focus()
      field.setSelectionRange(wanted, wanted)
      if (wanted !== caret) setCaret(wanted)
      return
    }
    if (field.selectionStart !== caret) setCaret(field.selectionStart)
  }, [value, caret])

  const runCommand = (command: LocalCommand, text = "") => {
    const carried = carriesMessage(command) ? attachments : []
    setValue("")
    if (carried.length) setAttachments([])
    void Promise.resolve(onCommand?.(command, { text, attachments: carried })).catch(() => {
      setValue((current) => current || `/${command}${text ? ` ${text}` : ""}`)
      setAttachments((current) => (current.length ? current : carried))
    })
  }

  const pick = (item: SlashItem) => {
    // A command that takes the rest of the message as its own says where the next message goes
    // rather than doing something on the press: it lands in the field like a skill's name, and Send
    // carries it out with whatever was typed after it (ADR 0096).
    if (item.kind === "command" && !isSendMode(item.name) && !carriesMessage(item.name)) {
      const run = localCommand(value, startable)
      return runCommand(item.name, run?.command === item.name ? run.text : "")
    }
    if (!token) return
    const next =
      item.kind === "command" && isSendMode(item.name)
        ? pickSendMode(value, token, item.name)
        : pickItem(value, token, item.name)
    caretWanted.current = next.caret
    setDismissed(false)
    setValue(next.text)
  }

  const submitText = (raw: string) => {
    const text = plain ? raw : (sendMode(raw)?.text ?? raw)
    if (!text.trim() && !attachments.length && !points.length) return
    const sent = attachments
    const steer = !plain && steersNow(raw, sent)
    // A point rides the message it was taken for: the model reads its label and its selector. A steer
    // is a nudge at the reply already running, so the chip waits for the message after it.
    const marked = steer ? text : pointText(text, points)
    const carried = steer ? [] : points
    setValue("")
    setAttachments([])
    if (carried.length) setPoints([])
    setPointing(false)
    const go = () => (steer ? onSteer!(text, sent) : (busy ? onQueue : onSend)(marked, sent))
    // Hand the message back if it never made it into the chat, unless something new was added.
    void Promise.resolve(go()).then(
      () => setRefused({}),
      (error: unknown) => {
        setValue((current) => current || raw)
        setAttachments((current) => (current.length ? current : sent))
        setPoints((current) => (current.length ? current : carried))
        // A file the Host refused is the one thing here worth interrupting for: the tile that
        // carries it turns red, and the Host's own sentence — the limit it names — is a toast on
        // the phone and the page's own toaster on the web. A send refused for another reason keeps
        // its place in the screen's own words, as it always has.
        if (!(error instanceof AttachmentError)) return
        const message =
          error.message || `Couldn't send ${sent.length > 1 ? "a file" : "that file"}.`
        if (error.attachmentId)
          setRefused((current) => ({ ...current, [error.attachmentId!]: message }))
        tell.error(message)
      },
    )
  }

  // `picked` is a file chosen on purpose, which lands however recently it was taken.
  const addFiles = async (files: File[], picked = false) => {
    // A paste and the drop the browser can also fire carry the same file, which lands once.
    const added = fresh(files, recent.current, Date.now(), { repeat: !picked })
    if (!added.length) return
    let placeholders: { id: string; name: string; image: boolean }[] = []
    const { attachments: prepared, refusals } = await prepareIntake(added, {
      held: attachments,
      reserved: preparing.length,
      readsImages: imagesAvailable,
      route: filesFeature,
      maxAttachments,
      onTake: (take) => {
        placeholders = take.map((file) => ({
          id: randomId(),
          name: file.name,
          image: file.type.startsWith("image/"),
        }))
        setPreparing((current) => [...current, ...placeholders])
      },
    })
    for (const refusal of refusals) tell.error(refusal.message)
    if (prepared.length)
      setAttachments((current) =>
        [...current, ...prepared].slice(0, maxAttachments ?? MAX_ATTACHMENTS),
      )
    setPreparing((current) => current.filter((one) => !placeholders.some((p) => p.id === one.id)))
    textarea.current?.focus()
  }

  // A pasted photo or file is the same intake as a picked one, and never a send.
  const pasted = (event: ClipboardEvent<HTMLTextAreaElement>) => {
    if (!files) return
    const data = event.clipboardData
    // `files` and `items` can each carry a file, and the same one twice; `fresh` takes it once.
    const taken = [...(data?.files ?? [])]
    for (const item of data?.items ?? [])
      if (item.kind === "file") {
        const file = item.getAsFile()
        if (file) taken.push(file)
      }
    if (!taken.length) return
    event.preventDefault()
    void addFiles(taken)
  }

  const dragging = (event: DragEvent<HTMLFormElement>) => {
    if (!files || !Array.from(event.dataTransfer?.types ?? []).includes("Files")) return
    event.preventDefault()
    setOver(true)
  }

  const dropped = (event: DragEvent<HTMLFormElement>) => {
    if (!files) return
    const taken = [...(event.dataTransfer?.files ?? [])]
    // Text dragged into the field is the field's own drop; only files are taken here.
    if (!taken.length) return
    event.preventDefault()
    setOver(false)
    void addFiles(taken)
  }

  const removeAttachment = (attachment: Attachment) => {
    setAttachments((current) => current.filter((a) => a.id !== attachment.id))
    setRefused((current) => {
      if (!(attachment.id in current)) return current
      const { [attachment.id]: _, ...rest } = current
      return rest
    })
  }

  // A staged file's bytes exist only on this device: the previewer draws them from their own URL,
  // which is the one place an object URL is still what a file is read from.
  const staged = (attachment: Attachment): PreviewItem =>
    previewItem(
      {
        key: attachment.id,
        kind: mediaKind(attachment.type, attachment.name),
        cell: drawnCell(attachment.type, attachment.name),
        name: attachment.name,
        type: attachment.type,
        size: attachment.size,
        src: canPreview(attachment) ? attachmentUrl(attachment) : undefined,
        state: "ready",
      },
      { width: attachment.width, height: attachment.height },
    )
  const media = attachments.filter(
    (attachment) => drawnCell(attachment.type, attachment.name) !== "file",
  )
  // A tap that means "look at this" opens the screen's own Previewer, here as in the thread; a file
  // the Previewer can't draw is handed to the platform instead.
  const open = (attachment: Attachment) => {
    if (!canPreview(attachment)) {
      void openAttachment(null, attachment)
      return
    }
    previewer(
      {
        items: media.map(staged),
        index: media.findIndex((one) => one.id === attachment.id),
        onRemove: (shown) => setAttachments((current) => current.filter((a) => a.id !== shown.key)),
      },
      owner,
    )
  }

  const stagedKeys = media.map((one) => one.id).join("\n")
  const stagedNow = useRef(media)
  useEffect(() => {
    stagedNow.current = media
  })
  useEffect(() => {
    refresh(owner, stagedNow.current.map(staged))
  }, [owner, stagedKeys, refresh])

  // Only a chat drawn beside a canvas's page offers this: the press arms the page, and the chip it
  // answers with rides the next message. It is asked for in the `+` sheet, where the other ways to
  // add context are, rather than as a fourth control on the toolbar's own row.
  const point =
    pointAt && !disabled
      ? { armed: pointing, onArm: () => setPointing((was) => !was) }
      : undefined

  const attach = files ? (
    <AttachMenu
      disabled={disabled}
      filesFeature={filesFeature}
      imagesAvailable={imagesAvailable}
      onAdd={(picked) => void addFiles(picked, true)}
      session={session}
      point={point}
    />
  ) : null

  const submit = (event?: FormEvent) => {
    event?.preventDefault()
    const command = plain ? null : localCommand(value, startable)
    if (command && !disabled) return runCommand(command.command, command.text)
    if (!canSend) return
    submitText(value)
    textarea.current?.focus()
  }

  const placeDictation = (landed: string, takeId: TakeId) => {
    if (dictationSends.current) {
      const text = joinText(value, landed)
      if (disabled) setValue(text)
      else submitText(text)
      return
    }
    setValue((current) => {
      const at = Math.min(dictationAt.current ?? current.length, current.length)
      const before = current.slice(0, at)
      const after = current.slice(at)
      const middle = joinText(landed)
      return `${before}${before && !/\s$/.test(before) ? " " : ""}${middle}${after && !/^\s/.test(after) ? " " : ""}${after}`
    })
    waitInserted(takeId)
    setTimeout(() => textarea.current?.focus())
  }

  // Send and Stop hold the bar for the same bound: the one the bot's host states (ADR 0074).
  const endDictation = async (send: boolean) => {
    dictationSends.current = send
    await dictation.finish(send ? "send" : "stop")
  }

  placeLanded.current = placeDictation

  const retryDictation = async () => {
    dictationAt.current ??= dictation.anchor()
    try {
      await dictation.retry()
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Couldn't start the microphone.")
    }
  }

  const startDictation = () => {
    dictationAt.current = textarea.current?.selectionStart ?? null
    dictationSends.current = false
    dictation
      .start(dictationAt.current)
      .catch((error: unknown) =>
        toast.error(error instanceof Error ? error.message : "Couldn't start the microphone."),
      )
  }

  const pressMic = (event: PointerEvent<HTMLButtonElement>) => {
    if (event.button !== 0) return
    event.preventDefault()
    press.current = { x: event.clientX, y: event.clientY }
    const up = (end: globalThis.PointerEvent) => {
      window.removeEventListener("pointerup", up)
      window.removeEventListener("pointercancel", up)
      const start = press.current
      press.current = null
      const since = dictation.recordingSince()
      // A tap, or a hold that ended while the mic was still being asked for, keeps recording, and
      // so does a press the browser took over (a scroll): the bar's own buttons end it then.
      if (!start || since === null || end.type === "pointercancel") return
      if (Date.now() - since < HOLD_MS) return
      const away = Math.hypot(end.clientX - start.x, end.clientY - start.y) > SLIDE_CANCEL_PX
      if (away) dictation.cancel()
      else void endDictation(false)
    }
    window.addEventListener("pointerup", up)
    window.addEventListener("pointercancel", up)
    startDictation()
  }

  if (dictation.status !== "idle") {
    return (
      <div className={COLUMN_BOX}>
        <VoiceBar
          status={dictation.status}
          levels={dictation.levels}
          startedAt={dictation.startedAt}
          failure={dictation.failure}
          onCancel={dictation.cancel}
          onStop={() => void endDictation(false)}
          onSend={() => void endDictation(true)}
          onRetry={() => void retryDictation()}
        />
      </div>
    )
  }

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.nativeEvent.isComposing) return
    if (menuOpen && items.length > 0) {
      const count = items.length
      if (event.key === "ArrowDown" || event.key === "ArrowUp") {
        event.preventDefault()
        setActive((activeIndex + (event.key === "ArrowDown" ? 1 : count - 1)) % count)
        return
      }
      if (
        (event.key === "Enter" && !event.shiftKey && !isSendChord(event.nativeEvent)) ||
        event.key === "Tab"
      ) {
        event.preventDefault()
        pick(items[activeIndex])
        return
      }
    }
    if (menuOpen && event.key === "Escape") {
      event.preventDefault()
      setDismissed(true)
      lastEscape.current = null
      return
    }
    const field = event.currentTarget
    if (isInterrupt(event.nativeEvent, working, field.selectionStart !== field.selectionEnd)) {
      event.preventDefault()
      pressStop()
      return
    }
    if (event.key === "Escape") {
      const now = Date.now()
      if (isDoubleEscape(lastEscape.current, now) && value) {
        event.preventDefault()
        lastEscape.current = null
        // Deleting through the field keeps its own undo, which setting the value would drop.
        field.select()
        if (!document.execCommand("delete")) setValue("")
        return
      }
      lastEscape.current = now
      // A field with text claims the pair: the first Escape is half of "Escape, Escape — Clear the
      // message", so nothing else may take it, and an Escape the shell closes the thread beside Main
      // with would end the pair before the reader could finish it. An empty field has nothing to
      // clear and lets the key through, which is how Escape puts that thread away.
      if (value) event.preventDefault()
    } else if (event.key !== "Shift" && event.key !== "Control" && event.key !== "Alt") {
      lastEscape.current = null
    }
    if (event.key === "Enter" && enterSends(event.nativeEvent, sendOnEnter)) {
      event.preventDefault()
      submit()
    }
  }

  const controls = (
    <>
      {dictationInfo && canRecord() && !disabled && !canDictate && (
        <MicUnavailable availability={dictationInfo} />
      )}
      {canDictate && !disabled && (
        <InputGroupButton
          type="button"
          variant="ghost"
          size="icon-sm"
          className="size-11 touch-none rounded-full select-none"
          onPointerDown={pressMic}
          onClick={(event) => {
            // Keyboard presses have no pointer; a pointer press already started.
            if (keyboardClick(event)) startDictation()
          }}
          onContextMenu={(event) => event.preventDefault()}
          aria-label="Voice"
        >
          <MicIcon />
        </InputGroupButton>
      )}
      {stopAsked || (working && !canSend) ? (
        // Left enabled rather than disabled, so a keyboard reader keeps their place and hears the
        // new label; `pressStop` is what refuses the second press.
        <InputGroupButton
          type="button"
          variant="secondary"
          size="icon-sm"
          className="size-11 rounded-full"
          aria-label={stopAsked ? "Stopping" : "Stop"}
          onClick={pressStop}
        >
          {stopAsked ? <Spinner aria-hidden /> : <SquareIcon className="fill-current" />}
        </InputGroupButton>
      ) : (
        <InputGroupButton
          type="submit"
          variant="default"
          size="icon-sm"
          className="size-11 rounded-full"
          disabled={!canSend}
          aria-label="Send"
        >
          <ArrowUpIcon />
        </InputGroupButton>
      )}
    </>
  )

  return (
    <form
      onSubmit={submit}
      onDragOver={dragging}
      onDragLeave={() => setOver(false)}
      onDrop={dropped}
      className={`${COLUMN_BOX} relative`}
    >
      {menuOpen && (
        <SlashMenu
          id={listId}
          items={items}
          active={activeIndex}
          status={skills.status}
          onPick={pick}
          onActive={setActive}
        />
      )}
      {points.length + attachments.length + preparing.length > 0 && (
        // Room on the right so the last tile's remove button isn't cut off.
        <div className="-mt-3 mb-2 flex gap-2.5 overflow-x-auto pt-3 pr-4 pl-1">
          {points.map((one, at) => (
            <PointChip
              key={`${one.selector}-${at}`}
              point={one}
              draft
              className="shrink-0 self-center"
              onRemove={() => setPoints((held) => held.filter((_, index) => index !== at))}
            />
          ))}
          {attachments.map((attachment) => (
            <AttachmentTile
              key={attachment.id}
              attachment={attachment}
              refused={refused[attachment.id]}
              onOpen={() => open(attachment)}
              onRemove={() => removeAttachment(attachment)}
            />
          ))}
          {preparing.map((item) => (
            <AttachmentTile key={item.id} attachment={{ ...item, type: "", size: 0 }} preparing />
          ))}
        </div>
      )}
      <InputGroup
        className={cn(
          "bg-background shadow-lg shadow-black/5 has-data-[align=block-end]:rounded-[1.75rem] has-[textarea]:rounded-[1.75rem] dark:bg-input/30",
          over && "ring-2 ring-ring/40",
        )}
      >
        {notice}
        <InputGroupTextarea
          ref={textarea}
          value={value}
          onChange={(event) => {
            setValue(event.target.value)
            const at = event.target.selectionStart ?? event.target.value.length
            setCaret(at)
            setActive(0)
            // An Escape belongs to the text it was pressed on: editing is the user asking for the
            // menu back, whether they typed in the token, cleared it or replaced the whole message.
            setDismissed(false)
          }}
          // A caret moved without a keystroke — a click, an arrow key — moves the menu with it.
          onSelect={(event) => setCaret(event.currentTarget.selectionStart ?? 0)}
          onPaste={pasted}
          onKeyDown={onKeyDown}
          enterKeyHint={sendOnEnter ? "send" : "enter"}
          role={menuOpen ? "combobox" : undefined}
          aria-expanded={menuOpen ? true : undefined}
          aria-controls={menuOpen ? listId : undefined}
          aria-autocomplete={menuOpen ? "list" : undefined}
          aria-activedescendant={
            menuOpen && items.length ? optionId(listId, activeIndex) : undefined
          }
          placeholder={
            placeholder ??
            (disabled
              ? "Connect to Hermes in Settings first"
              : busy
                ? steering
                  ? "Steer the response…"
                  : "Queue a message…"
                : `Message ${botName}…`)
          }
          disabled={disabled}
          rows={1}
          className={cn("max-h-48 min-h-12 px-5 pt-4 pb-2 text-base md:text-[15px]", face)}
          aria-label="Message"
        />
        <InputGroupAddon
          align="block-end"
          className="gap-1 px-2.5 pt-0 pb-1.5"
          onClick={(event) => {
            // Clicks in a pop-up its buttons open (the model list) bubble up the React tree too.
            if (event.currentTarget.contains(event.target as Node)) textarea.current?.focus()
          }}
        >
          {attach}
          {model}
          <span className="flex-1" />
          {controls}
        </InputGroupAddon>
      </InputGroup>
    </form>
  )
}

function MicUnavailable({
  availability,
}: {
  availability: DictationAvailability & { recheck: () => void }
}) {
  const mic = (
    <InputGroupButton
      type="button"
      variant="ghost"
      size="icon-sm"
      className="size-11 rounded-full text-muted-foreground opacity-50"
      disabled={availability.status === "checking"}
      aria-label="Speech-to-text unavailable"
    >
      <MicIcon />
    </InputGroupButton>
  )
  if (availability.status === "checking") return mic
  return (
    <Popover
      onOpenChange={(open) => {
        if (open && availability.status === "failed") availability.recheck()
      }}
    >
      <PopoverTrigger render={mic} />
      <PopoverContent side="top" align="end">
        {availability.status === "off"
          ? availability.reason
          : "Couldn't check with Hermes whether speech-to-text is on. Try again later."}
      </PopoverContent>
    </Popover>
  )
}

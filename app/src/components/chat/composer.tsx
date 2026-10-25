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
import { AttachmentTile, AttachmentViewer } from "@/components/chat/attachments"
import type { ModeSettings } from "@/components/chat/mode-menu"
import { SlashMenu } from "@/components/chat/slash-menu"
import { VoiceBar } from "@/components/chat/voice-bar"
import {
  InputGroup,
  InputGroupAddon,
  InputGroupButton,
  InputGroupTextarea,
} from "@/components/ui/input-group"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import { filesReason, fresh, isPhoto, MAX_ATTACHMENTS } from "@/lib/attachment-caps"
import { prepareIntake } from "@/lib/attachments"
import type { Attachment } from "@/lib/db"
import type { PluginFeatureAnswer } from "@/lib/features"

import { flushDrafts, loadDraft, saveDraft, useDraftText } from "@/lib/drafts"
import type { HermesConfig } from "@/lib/hermes"
import { COLUMN_BOX } from "@/lib/layout"
import {
  SEND_WAIT_MS,
  STOP_WAIT_MS,
  canRecord,
  joinText,
  keyboardClick,
  useChunkedDictation,
  useDictationInfo,
  type DictationAvailability,
} from "@/lib/dictation"
import {
  SEND_COMMANDS,
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
import { isDoubleEscape, isInterrupt } from "@/lib/keys"
import { useSkills } from "@/lib/skills"
import { midReply, steerAsked } from "@/lib/steer"
import { runnableSkills } from "@/lib/skills-cache"
import { cn, randomId } from "@/lib/utils"

const HOLD_MS = 400
const SLIDE_CANCEL_PX = 80

export function Composer({
  busy,
  disabled,
  onSend,
  onQueue,
  onStop,
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
  canSteer = false,
  onSteer,
  main = false,
}: {
  busy: boolean
  /** Whether a message sent while a reply runs steers it unless it starts with `/queue`. */
  steerByDefault?: boolean
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
  disabled?: boolean
  main?: boolean
  onSend: (text: string, attachments: Attachment[]) => Promise<void> | void
  /** Called instead of `onSend` while a reply is streaming: Enter queues the message. */
  onQueue: (text: string, attachments: Attachment[]) => Promise<void> | void
  onStop: () => void
  onCommand: (
    command: LocalCommand,
    message?: { text: string; attachments: Attachment[] },
  ) => Promise<void> | void
}) {
  const [value, setValue] = useState("")
  const [attachments, setAttachments] = useState<Attachment[]>([])
  // Picked files still being read, shown as placeholders where they'll land.
  const [preparing, setPreparing] = useState<{ id: string; name: string; image: boolean }[]>([])
  // Files taken moments ago, so a paste and the drop it can also fire add one copy.
  const recent = useRef(new Map<string, number>())
  // A file dragged over the composer, held until it is dropped or leaves.
  const [over, setOver] = useState(false)
  const [viewing, setViewing] = useState<number | null>(null)
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
  }
  // A draft that syncs in after mount fills the field only while it is still empty and untouched.
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
      void flushDrafts()
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
  // When the last Escape that had nothing else to close was pressed, for the double that clears.
  const lastEscape = useRef<number | null>(null)
  const listId = useId()
  const dictationInfo = useDictationInfo(connection)
  const placeHeard = useRef<(heard: string) => void>(() => {})
  const dictation = useChunkedDictation(
    connection,
    joinText(botName, dictationHint ?? ""),
    draftKey,
    dictationWords,
    (heard) => placeHeard.current(heard),
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

  const canSend =
    (value.trim().length > 0 || attachments.length > 0) && !disabled && preparing.length === 0
  // What Enter does now, so the button says so.
  const steering = steersNow(value, attachments)

  // The menu follows the caret: a `/` that begins a word opens it, wherever in the message it is.
  const token = slashToken(value, caret)
  const skills = useSkills(connection, Boolean(token) && !disabled)
  const skillItems: SlashItem[] =
    skills.status === "ok"
      ? runnableSkills(skills.skills).map((skill) => ({ kind: "skill", ...skill }))
      : []
  const items = token
    ? rankSlashItems([...localCommands(main), ...(busy ? SEND_COMMANDS : []), ...skillItems], token)
    : []
  // Escape closes the menu until the text changes: any edit opens it again, and so does a new `/`.
  const menuOpen =
    token !== null && !dismissed && !disabled && (items.length > 0 || skills.status !== "ok")
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
    const carried = command === "thread" ? attachments : []
    setValue("")
    if (carried.length) setAttachments([])
    void Promise.resolve(onCommand(command, { text, attachments: carried })).catch(() => {
      setValue((current) => current || `/${command}${text ? ` ${text}` : ""}`)
      setAttachments((current) => (current.length ? current : carried))
    })
  }

  const pick = (item: SlashItem) => {
    if (item.kind === "command" && !isSendMode(item.name)) {
      const run = localCommand(value, main)
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
    const text = sendMode(raw)?.text ?? raw
    if (!text.trim() && !attachments.length) return
    const sent = attachments
    const steer = steersNow(raw, sent)
    setValue("")
    setAttachments([])
    const go = () => (steer ? onSteer!(text, sent) : (busy ? onQueue : onSend)(text, sent))
    // Hand the message back if it never made it into the chat, unless something new was added.
    void Promise.resolve(go()).catch(() => {
      setValue((current) => current || raw)
      setAttachments((current) => (current.length ? current : sent))
    })
  }

  // `picked` is a file chosen on purpose, which lands however recently it was taken.
  const addFiles = async (files: File[], picked = false) => {
    // A paste and the drop the browser can also fire carry the same file, which lands once.
    const added = fresh(files, recent.current, Date.now(), { repeat: !picked })
    if (!added.length) return
    // Files need the plugin's upload route; a photo the model reads inline doesn't, and still lands.
    const because = filesReason(filesFeature)
    const taken = because ? added.filter((file) => imagesAvailable && isPhoto(file.type)) : added
    if (taken.length < added.length && because) toast.error(because)
    if (!taken.length) return
    let placeholders: { id: string; name: string; image: boolean }[] = []
    const { attachments: prepared, refusals } = await prepareIntake(taken, {
      held: attachments,
      reserved: preparing.length,
      inline: imagesAvailable,
      onTake: (take) => {
        placeholders = take.map((file) => ({
          id: randomId(),
          name: file.name,
          image: file.type.startsWith("image/"),
        }))
        setPreparing((current) => [...current, ...placeholders])
      },
    })
    for (const refusal of refusals) toast.error(refusal.message)
    if (prepared.length)
      setAttachments((current) => [...current, ...prepared].slice(0, MAX_ATTACHMENTS))
    setPreparing((current) => current.filter((one) => !placeholders.some((p) => p.id === one.id)))
    textarea.current?.focus()
  }

  // A pasted photo or file is the same intake as a picked one, and never a send.
  const pasted = (event: ClipboardEvent<HTMLTextAreaElement>) => {
    const data = event.clipboardData
    // `files` and `items` can each carry a file, and the same one twice; `fresh` takes it once.
    const files = [...(data?.files ?? [])]
    for (const item of data?.items ?? [])
      if (item.kind === "file") {
        const file = item.getAsFile()
        if (file) files.push(file)
      }
    if (!files.length) return
    event.preventDefault()
    void addFiles(files)
  }

  const dragging = (event: DragEvent<HTMLFormElement>) => {
    if (!Array.from(event.dataTransfer?.types ?? []).includes("Files")) return
    event.preventDefault()
    setOver(true)
  }

  const dropped = (event: DragEvent<HTMLFormElement>) => {
    const files = [...(event.dataTransfer?.files ?? [])]
    // Text dragged into the field is the field's own drop; only files are taken here.
    if (!files.length) return
    event.preventDefault()
    setOver(false)
    void addFiles(files)
  }

  const removeAttachment = (attachment: Attachment) =>
    setAttachments((current) => current.filter((a) => a.id !== attachment.id))

  const attach = (
    <AttachMenu
      disabled={disabled}
      filesFeature={filesFeature}
      imagesAvailable={imagesAvailable}
      onAdd={(files) => void addFiles(files, true)}
      session={session}
    />
  )

  const submit = (event?: FormEvent) => {
    event?.preventDefault()
    const command = localCommand(value, main)
    if (command && !disabled) return runCommand(command.command, command.text)
    if (!canSend) return
    submitText(value)
    textarea.current?.focus()
  }

  const placeDictation = (heard: string) => {
    if (dictationSends.current) {
      const text = joinText(value, heard)
      if (disabled) setValue(text)
      else submitText(text)
      return
    }
    setValue((current) => {
      const at = Math.min(dictationAt.current ?? current.length, current.length)
      const before = current.slice(0, at)
      const after = current.slice(at)
      const middle = joinText(heard)
      return `${before}${before && !/\s$/.test(before) ? " " : ""}${middle}${after && !/^\s/.test(after) ? " " : ""}${after}`
    })
    setTimeout(() => textarea.current?.focus())
  }

  const endDictation = async (send: boolean) => {
    dictationSends.current = send
    const heard = await dictation.finish(send ? SEND_WAIT_MS : STOP_WAIT_MS)
    if (heard) placeDictation(heard)
  }

  placeHeard.current = placeDictation

  const retryDictation = async () => {
    dictationAt.current ??= dictation.anchor()
    try {
      const heard = await dictation.retry()
      if (heard) placeDictation(heard)
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
      if ((event.key === "Enter" && !event.shiftKey) || event.key === "Tab") {
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
    if (isInterrupt(event.nativeEvent, busy, field.selectionStart !== field.selectionEnd)) {
      event.preventDefault()
      onStop()
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
    } else if (event.key !== "Shift" && event.key !== "Control" && event.key !== "Alt") {
      lastEscape.current = null
    }
    if (event.key === "Enter" && !event.shiftKey) {
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
      {busy && !canSend ? (
        <InputGroupButton
          type="button"
          variant="secondary"
          size="icon-sm"
          className="size-11 rounded-full"
          onClick={onStop}
          aria-label="Stop"
        >
          <SquareIcon className="fill-current" />
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
      {attachments.length + preparing.length > 0 && (
        // Room on the right so the last tile's remove button isn't cut off.
        <div className="-mt-3 mb-2 flex gap-2.5 overflow-x-auto pt-3 pr-4 pl-1">
          {attachments.map((attachment, index) => (
            <AttachmentTile
              key={attachment.id}
              attachment={attachment}
              onOpen={() => setViewing(index)}
              onRemove={() => removeAttachment(attachment)}
            />
          ))}
          {preparing.map((item) => (
            <AttachmentTile key={item.id} attachment={{ ...item, type: "", size: 0 }} preparing />
          ))}
        </div>
      )}
      <AttachmentViewer
        attachments={attachments}
        index={viewing}
        onIndex={setViewing}
        onRemove={removeAttachment}
      />
      <InputGroup
        className={cn(
          "bg-background shadow-lg shadow-black/5 has-data-[align=block-end]:rounded-[1.75rem] has-[textarea]:rounded-[1.75rem] dark:bg-input/30",
          over && "ring-2 ring-ring/40",
        )}
      >
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
          enterKeyHint="send"
          role={menuOpen ? "combobox" : undefined}
          aria-expanded={menuOpen ? true : undefined}
          aria-controls={menuOpen ? listId : undefined}
          aria-autocomplete={menuOpen ? "list" : undefined}
          aria-activedescendant={
            menuOpen && items.length ? optionId(listId, activeIndex) : undefined
          }
          placeholder={
            disabled
              ? "Connect to Hermes in Settings first"
              : busy
                ? steering
                  ? "Steer the response…"
                  : "Queue a message…"
                : `Message ${botName}…`
          }
          disabled={disabled}
          rows={1}
          className="max-h-48 min-h-12 px-5 pt-4 pb-2 text-base md:text-[15px]"
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
      aria-label="Voice unavailable"
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

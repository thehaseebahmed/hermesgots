import {
  useEffect,
  useId,
  useRef,
  useState,
  type FormEvent,
  type KeyboardEvent,
  type ReactNode,
} from "react"
import { ArrowUpIcon, CornerDownRightIcon, ListPlusIcon, MicIcon, SquareIcon } from "lucide-react"
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
import {
  formatBytes,
  inlineBytes,
  MAX_ATTACHMENTS,
  MAX_INLINE_BYTES,
  prepareAttachment,
} from "@/lib/attachments"
import type { Attachment } from "@/lib/db"
import type { HermesConfig } from "@/lib/hermes"
import { joinText, useDictation } from "@/lib/speech"
import {
  isSendMode,
  localCommand,
  optionId,
  sendMode,
  useSlashItems,
  type LocalCommand,
  type SlashItem,
} from "@/lib/slash"
import { randomId } from "@/lib/utils"

export function Composer({
  busy,
  disabled,
  onSend,
  onQueue,
  onStop,
  onCommand,
  connection,
  botName = "Hermes",
  model,
  session,
  filesAvailable,
  imagesAvailable,
  draft,
  onDraft,
  steerByDefault = false,
  canSteer = false,
  onSteer,
}: {
  busy: boolean
  /** Whether a message sent while a reply runs steers it unless it starts with `/queue`. */
  steerByDefault?: boolean
  /** Whether the running reply can be steered. */
  canSteer?: boolean
  /** Sends text to the running reply now (`/steer`). */
  onSteer?: (text: string) => Promise<void> | void
  /** Text to start with, e.g. a session's saved draft. */
  draft?: string
  /** Called with the text as it changes. */
  onDraft?: (text: string) => void
  /** The chat's Hermes profile, for the skills in the `/` menu. */
  connection: HermesConfig
  botName?: string
  /** The model pill, beside the `+` button. */
  model?: ReactNode
  /** A project session: its permission mode, picked in the `+` menu. */
  session?: ModeSettings
  /** Whether files can be attached (they need the Memento plugin); photos always can. */
  filesAvailable: boolean
  /** False when the model doesn't take images. */
  imagesAvailable: boolean
  disabled?: boolean
  onSend: (text: string, attachments: Attachment[]) => Promise<void> | void
  /** Called instead of `onSend` while a reply is streaming: Enter queues the message. */
  onQueue: (text: string, attachments: Attachment[]) => Promise<void> | void
  onStop: () => void
  onCommand: (command: LocalCommand) => void
}) {
  const [value, setValue] = useState("")
  const [attachments, setAttachments] = useState<Attachment[]>([])
  // Picked files still being read, shown as placeholders where they'll land.
  const [preparing, setPreparing] = useState<{ id: string; name: string; image: boolean }[]>([])
  const [viewing, setViewing] = useState<number | null>(null)
  const seeded = useRef(false)
  useEffect(() => {
    if (seeded.current || !draft) return
    seeded.current = true
    setValue((current) => current || draft)
  }, [draft])
  useEffect(() => onDraft?.(value), [value, onDraft])
  const [dismissed, setDismissed] = useState(false)
  const [active, setActive] = useState(0)
  const textarea = useRef<HTMLTextAreaElement>(null)
  const listId = useId()
  const dictation = useDictation()
  // `/steer` or `/queue` picks how a message sent mid-reply goes; the setting is the default. Only
  // text can steer, so a message with files waits in the queue. An explicit `/steer` asks the
  // host even when the reply looks unsteerable, and falls back to the queue with a toast.
  const steersNow = (text: string, files: number) => {
    const chosen = sendMode(text)
    const mode = chosen?.mode ?? (steerByDefault ? "steer" : "queue")
    return busy && Boolean(onSteer) && !files && mode === "steer" && (Boolean(chosen) || canSteer)
  }

  const canSend =
    (value.trim().length > 0 || attachments.length > 0) && !disabled && preparing.length === 0
  // What Enter does now, so the button says so.
  const steering = steersNow(value, attachments.length)

  const query = /^\/(\S*)$/.exec(value)?.[1]
  const slash = useSlashItems(query !== undefined && !disabled, query ?? "", connection, busy)
  const menuOpen =
    query !== undefined &&
    !dismissed &&
    !disabled &&
    (slash.items.length > 0 || slash.status !== "ok")
  const activeIndex = Math.min(active, Math.max(slash.items.length - 1, 0))

  const runCommand = (command: LocalCommand) => {
    setValue("")
    onCommand(command)
  }

  const pick = (item: SlashItem) => {
    if (item.kind === "command" && !isSendMode(item.name)) return runCommand(item.name)
    setValue(`/${item.name} `)
    textarea.current?.focus()
  }

  const submitText = (raw: string) => {
    const text = sendMode(raw)?.text ?? raw
    if (!text.trim() && !attachments.length) return
    const sent = attachments
    const steer = steersNow(raw, sent.length)
    setValue("")
    setAttachments([])
    const go = () => (steer ? onSteer!(text) : (busy ? onQueue : onSend)(text, sent))
    // Hand the message back if it never made it into the chat, unless something new was added.
    void Promise.resolve(go()).catch(() => {
      setValue((current) => current || raw)
      setAttachments((current) => (current.length ? current : sent))
    })
  }

  const addFiles = async (files: File[]) => {
    const room = MAX_ATTACHMENTS - attachments.length - preparing.length
    const taken = files.slice(0, Math.max(room, 0))
    if (files.length > taken.length) {
      const left = files.length - taken.length
      toast.error(
        `A message can carry ${MAX_ATTACHMENTS} attachments, so ${left === 1 ? "1 was" : `${left} were`} left out.`,
      )
    }
    const placeholders = taken.map((file) => ({
      id: randomId(),
      name: file.name,
      image: file.type.startsWith("image/"),
    }))
    setPreparing((current) => [...current, ...placeholders])
    let inline = inlineBytes(attachments)
    for (const [index, file] of taken.entries()) {
      try {
        const attachment = await prepareAttachment(file, imagesAvailable)
        const size = attachment.image ? attachment.blob!.size : 0
        if (inline + size > MAX_INLINE_BYTES) {
          toast.error(
            `${attachment.name} doesn't fit: a message's photos can add up to ${formatBytes(MAX_INLINE_BYTES)}. Send it in the next one.`,
          )
        } else {
          inline += size
          setAttachments((current) => [...current, attachment].slice(0, MAX_ATTACHMENTS))
        }
      } catch (error) {
        toast.error(error instanceof Error ? error.message : `Couldn't attach ${file.name}.`)
      } finally {
        const done = placeholders[index].id
        setPreparing((current) => current.filter((p) => p.id !== done))
      }
    }
    textarea.current?.focus()
  }

  const removeAttachment = (attachment: Attachment) =>
    setAttachments((current) => current.filter((a) => a.id !== attachment.id))

  const attach = (
    <AttachMenu
      disabled={disabled}
      filesAvailable={filesAvailable}
      imagesAvailable={imagesAvailable}
      onAdd={(files) => void addFiles(files)}
      session={session}
    />
  )

  const submit = (event?: FormEvent) => {
    event?.preventDefault()
    const command = localCommand(value)
    if (command && !disabled) return runCommand(command)
    if (!canSend) return
    submitText(value)
    textarea.current?.focus()
  }

  const stopDictation = async () => {
    const heard = await dictation.finish()
    if (heard) setValue((current) => joinText(current, heard))
    setTimeout(() => textarea.current?.focus())
  }

  const sendDictation = async () => {
    const heard = await dictation.finish()
    if (!heard) return
    const text = joinText(value, heard)
    if (disabled) setValue(text)
    else submitText(text)
  }

  if (dictation.status !== "idle") {
    return (
      <div className="mx-auto w-full max-w-3xl">
        <VoiceBar
          final={dictation.final}
          interim={dictation.interim}
          levels={dictation.levels}
          finishing={dictation.status === "finishing"}
          onCancel={dictation.cancel}
          onStop={() => void stopDictation()}
          onSend={() => void sendDictation()}
        />
      </div>
    )
  }

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.nativeEvent.isComposing) return
    if (menuOpen && slash.items.length > 0) {
      const count = slash.items.length
      if (event.key === "ArrowDown" || event.key === "ArrowUp") {
        event.preventDefault()
        setActive((activeIndex + (event.key === "ArrowDown" ? 1 : count - 1)) % count)
        return
      }
      if ((event.key === "Enter" && !event.shiftKey) || event.key === "Tab") {
        event.preventDefault()
        pick(slash.items[activeIndex])
        return
      }
    }
    if (menuOpen && event.key === "Escape") {
      event.preventDefault()
      setDismissed(true)
      return
    }
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault()
      submit()
    }
  }

  const controls = (
    <>
      {dictation.supported && !disabled && (
        <InputGroupButton
          type="button"
          variant="ghost"
          size="icon-sm"
          className="size-11 rounded-full"
          onClick={dictation.start}
          aria-label="Voice"
        >
          <MicIcon />
        </InputGroupButton>
      )}
      {busy ? (
        <>
          {canSend && (
            <InputGroupButton
              type="submit"
              variant="ghost"
              size="icon-sm"
              className="size-11 rounded-full"
              aria-label={steering ? "Steer" : "Queue"}
            >
              {steering ? <CornerDownRightIcon /> : <ListPlusIcon />}
            </InputGroupButton>
          )}
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
        </>
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
    <form onSubmit={submit} className="relative mx-auto w-full max-w-3xl">
      {menuOpen && (
        <SlashMenu
          id={listId}
          items={slash.items}
          active={activeIndex}
          status={slash.status}
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
      <InputGroup className="bg-background shadow-lg shadow-black/5 has-data-[align=block-end]:rounded-[1.75rem] has-[textarea]:rounded-[1.75rem] dark:bg-input/30">
        <InputGroupTextarea
          ref={textarea}
          value={value}
          onChange={(event) => {
            setValue(event.target.value)
            setActive(0)
            if (!event.target.value.startsWith("/")) setDismissed(false)
          }}
          onKeyDown={onKeyDown}
          enterKeyHint="send"
          role={menuOpen ? "combobox" : undefined}
          aria-expanded={menuOpen ? true : undefined}
          aria-controls={menuOpen ? listId : undefined}
          aria-autocomplete={menuOpen ? "list" : undefined}
          aria-activedescendant={
            menuOpen && slash.items.length ? optionId(listId, activeIndex) : undefined
          }
          placeholder={
            disabled
              ? "Connect to Hermes in Settings first"
              : busy
                ? "Queue a message…"
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
          onClick={() => textarea.current?.focus()}
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

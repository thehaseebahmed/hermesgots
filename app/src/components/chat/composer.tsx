import {
  useEffect,
  useId,
  useRef,
  useState,
  type FormEvent,
  type KeyboardEvent,
  type ReactNode,
} from "react"
import { ArrowUpIcon, MicIcon, SquareIcon } from "lucide-react"
import { toast } from "sonner"

import { AttachMenu } from "@/components/chat/attach-menu"
import { AttachmentTile } from "@/components/chat/attachments"
import { ModeMenu } from "@/components/chat/mode-menu"
import { SlashMenu } from "@/components/chat/slash-menu"
import { VoiceBar } from "@/components/chat/voice-bar"
import {
  InputGroup,
  InputGroupAddon,
  InputGroupButton,
  InputGroupTextarea,
} from "@/components/ui/input-group"
import { MAX_ATTACHMENTS, prepareAttachment } from "@/lib/attachments"
import type { Attachment, SessionMode } from "@/lib/db"
import type { HermesConfig, TheseusInfo } from "@/lib/hermes"
import { joinText, useDictation } from "@/lib/speech"
import { cn } from "@/lib/utils"
import {
  localCommand,
  optionId,
  useSlashItems,
  type LocalCommand,
  type SlashItem,
} from "@/lib/slash"

export function Composer({
  busy,
  disabled,
  onSend,
  onQueue,
  onStop,
  onCommand,
  connection,
  botName = "Hermes",
  leading,
  session,
  filesAvailable,
  imagesAvailable,
  draft,
  onDraft,
}: {
  busy: boolean
  /** Text to start with, e.g. a session's saved draft. */
  draft?: string
  /** Called with the text as it changes. */
  onDraft?: (text: string) => void
  /** The chat's Hermes profile, for the skills in the `/` menu. */
  connection: HermesConfig
  botName?: string
  /** Shown at the start of the input (in a session, on its bottom row), e.g. the context ring. */
  leading?: ReactNode
  /** A project session: two lines, with the `+` menu and its permission mode under the text. */
  session?: {
    mode: SessionMode
    onMode: (mode: SessionMode) => void
    autoAvailable: boolean
    /** What the bot's host says about Theseus: undefined while asking, null without the plugin's support. */
    theseus?: TheseusInfo | null
    started?: boolean
  }
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
  const canSend = (value.trim().length > 0 || attachments.length > 0) && !disabled

  const query = /^\/(\S*)$/.exec(value)?.[1]
  const slash = useSlashItems(query !== undefined && !disabled, query ?? "", connection)
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
    if (item.kind === "command") return runCommand(item.name)
    setValue(`/${item.name} `)
    textarea.current?.focus()
  }

  const submitText = (text: string) => {
    const sent = attachments
    setValue("")
    setAttachments([])
    // Hand the message back if it never made it into the chat, unless something new was added.
    void Promise.resolve((busy ? onQueue : onSend)(text, sent)).catch(() => {
      setValue((current) => current || text)
      setAttachments((current) => (current.length ? current : sent))
    })
  }

  const addFiles = async (files: File[]) => {
    const room = MAX_ATTACHMENTS - attachments.length
    if (files.length > room) toast.error(`A message can carry ${MAX_ATTACHMENTS} attachments.`)
    const added: Attachment[] = []
    for (const file of files.slice(0, Math.max(room, 0))) {
      try {
        added.push(await prepareAttachment(file, imagesAvailable))
      } catch (error) {
        toast.error(error instanceof Error ? error.message : `Couldn't attach ${file.name}.`)
      }
    }
    if (added.length) setAttachments((current) => [...current, ...added].slice(0, MAX_ATTACHMENTS))
    textarea.current?.focus()
  }

  const attach = (
    <AttachMenu
      disabled={disabled}
      filesAvailable={filesAvailable}
      imagesAvailable={imagesAvailable}
      onAdd={(files) => void addFiles(files)}
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
      {attachments.length > 0 && (
        <div className="-mt-3 mb-2 flex gap-2.5 overflow-x-auto px-1 pt-3">
          {attachments.map((attachment) => (
            <AttachmentTile
              key={attachment.id}
              attachment={attachment}
              onRemove={() =>
                setAttachments((current) => current.filter((a) => a.id !== attachment.id))
              }
            />
          ))}
        </div>
      )}
      <InputGroup
        className={cn(
          "bg-background shadow-lg shadow-black/5 has-[textarea]:rounded-[1.75rem] dark:bg-input/30",
          session && "has-data-[align=block-end]:rounded-[1.75rem]",
        )}
      >
        {!session && (
          <InputGroupAddon align="inline-start" className="gap-0 self-end py-1.5 pl-1.5">
            {attach}
            {leading}
          </InputGroupAddon>
        )}
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
          className={cn(
            "max-h-48 text-base md:text-[15px]",
            session ? "min-h-12 px-5 pt-4 pb-2" : "min-h-14 py-4",
            !session && "pr-5 pl-1",
          )}
          aria-label="Message"
        />
        {session ? (
          <InputGroupAddon
            align="block-end"
            className="gap-1 px-2.5 pt-0 pb-1.5"
            onClick={() => textarea.current?.focus()}
          >
            {attach}
            <ModeMenu
              mode={session.mode}
              onChange={session.onMode}
              disabled={disabled}
              autoAvailable={session.autoAvailable}
              theseus={session.theseus}
              started={session.started}
            />
            <span className="flex-1" />
            {leading}
            {controls}
          </InputGroupAddon>
        ) : (
          <InputGroupAddon align="inline-end" className="self-end py-1.5 pr-2.5">
            {controls}
          </InputGroupAddon>
        )}
      </InputGroup>
    </form>
  )
}

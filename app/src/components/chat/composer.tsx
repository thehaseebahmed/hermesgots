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

import { AttachMenu } from "@/components/chat/attach-menu"
import { ModeMenu } from "@/components/chat/mode-menu"
import { SlashMenu } from "@/components/chat/slash-menu"
import { VoiceBar } from "@/components/chat/voice-bar"
import {
  InputGroup,
  InputGroupAddon,
  InputGroupButton,
  InputGroupTextarea,
} from "@/components/ui/input-group"
import type { SessionMode } from "@/lib/db"
import type { HermesConfig } from "@/lib/hermes"
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
  session?: { mode: SessionMode; onMode: (mode: SessionMode) => void; autoAvailable: boolean }
  disabled?: boolean
  onSend: (text: string) => Promise<void> | void
  /** Called instead of `onSend` while a reply is streaming: Enter queues the message. */
  onQueue: (text: string) => Promise<void> | void
  onStop: () => void
  onCommand: (command: LocalCommand) => void
}) {
  const [value, setValue] = useState("")
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
  const canSend = value.trim().length > 0 && !disabled

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
    setValue("")
    // Hand the text back if it never made it into the chat, unless something new was typed.
    void Promise.resolve((busy ? onQueue : onSend)(text)).catch(() =>
      setValue((current) => current || text),
    )
  }

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
      <InputGroup
        className={cn(
          "bg-background shadow-lg shadow-black/5 has-[textarea]:rounded-[1.75rem] dark:bg-input/30",
          session && "has-data-[align=block-end]:rounded-[1.75rem]",
        )}
      >
        {leading && !session && (
          <InputGroupAddon align="inline-start" className="self-end py-1.5 pl-2.5">
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
            !session && (leading ? "pr-5 pl-2" : "px-5"),
          )}
          aria-label="Message"
        />
        {session ? (
          <InputGroupAddon
            align="block-end"
            className="gap-1 px-2.5 pt-0 pb-1.5"
            onClick={() => textarea.current?.focus()}
          >
            <AttachMenu disabled={disabled} />
            <ModeMenu
              mode={session.mode}
              onChange={session.onMode}
              disabled={disabled}
              autoAvailable={session.autoAvailable}
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

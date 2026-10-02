import { useId, useRef, useState, type FormEvent, type KeyboardEvent, type ReactNode } from "react"
import { ArrowUpIcon, ListPlusIcon, SquareIcon } from "lucide-react"

import { SlashMenu } from "@/components/chat/slash-menu"
import {
  InputGroup,
  InputGroupAddon,
  InputGroupButton,
  InputGroupTextarea,
} from "@/components/ui/input-group"
import type { HermesConfig } from "@/lib/hermes"
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
}: {
  busy: boolean
  /** The chat's Hermes profile, for the skills in the `/` menu. */
  connection: HermesConfig
  botName?: string
  /** Shown at the start of the input, e.g. the context ring. */
  leading?: ReactNode
  disabled?: boolean
  onSend: (text: string) => Promise<void> | void
  /** Called instead of `onSend` while a reply is streaming. */
  onQueue: (text: string) => Promise<void> | void
  onStop: () => void
  onCommand: (command: LocalCommand) => void
}) {
  const [value, setValue] = useState("")
  const [dismissed, setDismissed] = useState(false)
  const [active, setActive] = useState(0)
  const textarea = useRef<HTMLTextAreaElement>(null)
  const listId = useId()
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

  const submit = (event?: FormEvent) => {
    event?.preventDefault()
    const command = localCommand(value)
    if (command && !disabled) return runCommand(command)
    if (!canSend) return
    const text = value
    setValue("")
    // Hand the text back if it never made it into the chat, unless something new was typed.
    void Promise.resolve((busy ? onQueue : onSend)(text)).catch(() =>
      setValue((current) => current || text),
    )
    textarea.current?.focus()
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
      <InputGroup className="bg-background shadow-lg shadow-black/5 has-[textarea]:rounded-[1.75rem] dark:bg-input/30">
        {leading && (
          <InputGroupAddon align="inline-start" className="self-end py-0.5 pl-0.5">
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
            "max-h-48 min-h-12 py-3.5 text-base md:text-[15px]",
            leading ? "pr-5 pl-1" : "px-5",
          )}
          aria-label="Message"
        />
        <InputGroupAddon align="inline-end" className="gap-1.5 self-end pb-2">
          {busy && (
            <InputGroupButton
              type="button"
              variant="secondary"
              size="icon-sm"
              className="size-9 rounded-full"
              onClick={onStop}
              aria-label="Stop"
            >
              <SquareIcon className="fill-current" />
            </InputGroupButton>
          )}
          {(!busy || canSend) && (
            <InputGroupButton
              type="submit"
              variant="default"
              size="icon-sm"
              className="size-9 rounded-full"
              disabled={!canSend}
              aria-label={busy ? "Queue message" : "Send"}
            >
              {busy ? <ListPlusIcon /> : <ArrowUpIcon />}
            </InputGroupButton>
          )}
        </InputGroupAddon>
      </InputGroup>
    </form>
  )
}

import { useRef, useState, type FormEvent, type KeyboardEvent } from "react"
import { ArrowUpIcon, SquareIcon } from "lucide-react"

import {
  InputGroup,
  InputGroupAddon,
  InputGroupButton,
  InputGroupTextarea,
} from "@/components/ui/input-group"

export function Composer({
  busy,
  disabled,
  onSend,
  onStop,
}: {
  busy: boolean
  disabled?: boolean
  onSend: (text: string) => Promise<void> | void
  onStop: () => void
}) {
  const [value, setValue] = useState("")
  const textarea = useRef<HTMLTextAreaElement>(null)
  const canSend = value.trim().length > 0 && !busy && !disabled

  const submit = (event?: FormEvent) => {
    event?.preventDefault()
    if (!canSend) return
    const text = value
    setValue("")
    // Hand the text back if it never made it into the chat, unless something new was typed.
    void Promise.resolve(onSend(text)).catch(() => setValue((current) => current || text))
    textarea.current?.focus()
  }

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    // Enter sends on devices with a hardware keyboard; on touch keyboards Enter is a newline.
    const coarse = window.matchMedia("(pointer: coarse)").matches
    if (event.key === "Enter" && !event.shiftKey && !coarse && !event.nativeEvent.isComposing) {
      event.preventDefault()
      submit()
    }
  }

  return (
    <form onSubmit={submit} className="mx-auto w-full max-w-3xl">
      <InputGroup className="bg-background shadow-lg shadow-black/5 has-[textarea]:rounded-[1.75rem] dark:bg-input/30">
        <InputGroupTextarea
          ref={textarea}
          value={value}
          onChange={(event) => setValue(event.target.value)}
          onKeyDown={onKeyDown}
          placeholder={disabled ? "Connect to Hermes in Settings first" : "Message Hermes…"}
          disabled={disabled}
          rows={1}
          className="max-h-48 min-h-12 px-5 py-3.5 text-base md:text-[15px]"
          aria-label="Message"
        />
        <InputGroupAddon align="inline-end" className="self-end pb-2">
          {busy ? (
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
          ) : (
            <InputGroupButton
              type="submit"
              variant="default"
              size="icon-sm"
              className="size-9 rounded-full"
              disabled={!canSend}
              aria-label="Send"
            >
              <ArrowUpIcon />
            </InputGroupButton>
          )}
        </InputGroupAddon>
      </InputGroup>
    </form>
  )
}

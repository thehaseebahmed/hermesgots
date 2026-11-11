/**
 * The app's one search field: 44px, a filled pill, a magnifier, and a clear button a thumb can find.
 * It owns the frame, the placeholder's job as the accessible name, the clear, and the search input's
 * own quirks (a browser's native clear is hidden, the field never autocompletes). What the words
 * narrow — a list, a pick, a set of models — stays the caller's.
 */
import type { KeyboardEvent, Ref } from "react"
import { SearchIcon, XIcon } from "lucide-react"

import {
  InputGroup,
  InputGroupAddon,
  InputGroupButton,
  InputGroupInput,
} from "@/components/ui/input-group"
import { cn } from "@/lib/utils"

export function SearchField({
  value,
  onChange,
  label,
  inputRef,
  onKeyDown,
  id,
  autoFocus,
  className,
}: {
  value: string
  onChange: (value: string) => void
  /** The field's placeholder and its name. */
  label: string
  inputRef?: Ref<HTMLInputElement>
  onKeyDown?: (event: KeyboardEvent<HTMLInputElement>) => void
  /** The field's own name, for the control that shows and hides it (`aria-controls`). */
  id?: string
  /** A field a form opens on: the one that lands under the caret. */
  autoFocus?: boolean
  /** One class from the caller, for a field that has to be as tall as the control beside it. */
  className?: string
}) {
  return (
    <InputGroup className={cn("h-11 rounded-full bg-background dark:bg-input/30", className)}>
      <InputGroupAddon>
        <SearchIcon />
      </InputGroupAddon>
      <InputGroupInput
        ref={inputRef}
        id={id}
        type="search"
        value={value}
        onChange={(event) => onChange(event.target.value)}
        onKeyDown={onKeyDown}
        placeholder={label}
        aria-label={label}
        autoComplete="off"
        autoFocus={autoFocus}
        className="[&::-webkit-search-cancel-button]:hidden"
      />
      {value && (
        <InputGroupAddon align="inline-end">
          <InputGroupButton
            size="icon-sm"
            // A full 44px target: the field is 44 tall, and a clear control a thumb has to find is
            // the one place a smaller icon would cost the tap.
            className="size-11 rounded-full"
            onClick={() => onChange("")}
            aria-label="Clear search"
          >
            <XIcon />
          </InputGroupButton>
        </InputGroupAddon>
      )}
    </InputGroup>
  )
}

/**
 * The search a list keeps at its foot: a 44px circle that becomes a field as tall as the controls
 * beside it, in the same row, so nothing above the foot moves when it opens.
 *
 * The component owns the surface and nothing of what the words narrow: which rows the query keeps is
 * the screen's, and the words themselves are its `query`. What it owns is what a reader feels — the
 * circle opening the field, the field taking the focus as it takes the circle's place, Escape closing
 * it, the focus back on the circle as it goes, and the words let go of with it, because a list
 * narrowed by a query nobody can see reads as a list that lost rows. An empty field is a search that
 * found everything, not a reason to shut, so backspacing the last character keeps the focus where the
 * reader is.
 *
 * The host holds the state (whether the field is up, and the words) and tells this component what to
 * draw; the field's own id comes from it, so a list whose bar holds a field at a wider width never has
 * two of them in the tree (ADR 0145). A host that closes the field from somewhere of its own — the
 * chat list's button wearing the X while the search holds the foot — says so by handing `open` false,
 * and the words go with it the same way.
 */
import { useEffect, useRef } from "react"
import { SearchIcon, XIcon } from "lucide-react"

import { SearchField } from "@/components/search-field"
import { Button } from "@/components/ui/button"

export function FootSearch({
  open,
  onOpen,
  onClose,
  query,
  onQueryChange,
  label,
  fieldId,
}: {
  /** Whether the field stands in the circle's place. */
  open: boolean
  /** The circle pressed: the field takes its place and its focus. */
  onOpen: () => void
  /** The field's own way out, which is Escape: the host puts its surface away. */
  onClose: () => void
  /** The words the list is narrowed by: the host's, never a copy of them here. */
  query: string
  onQueryChange: (query: string) => void
  /** The field's placeholder and its accessible name. */
  label: string
  /** The field's id, for the control that shows and hides it. */
  fieldId: string
}) {
  const toggle = useRef<HTMLButtonElement>(null)
  const field = useRef<HTMLInputElement>(null)
  // Whether the field was up the last time this ran: closing clears the words and returns the focus,
  // and a foot that has never held a search owes neither.
  const wasOpen = useRef(false)

  useEffect(() => {
    if (open) {
      wasOpen.current = true
      window.requestAnimationFrame(() => field.current?.focus())
      return
    }
    if (!wasOpen.current) return
    wasOpen.current = false
    onQueryChange("")
    window.requestAnimationFrame(() => toggle.current?.focus())
    // The host's callback is read here rather than tracked: it is one setter, and a foot that closed
    // owes its words clearing however the host's own render reads.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open])

  if (!open)
    return (
      <Button
        ref={toggle}
        variant="outline"
        size="icon-lg"
        className="pointer-events-auto size-11 shrink-0 rounded-full bg-background shadow-lg"
        onClick={onOpen}
        aria-label="Search"
        data-search-toggle
      >
        <SearchIcon />
      </Button>
    )

  return (
    <div className="pointer-events-auto min-w-0 flex-1">
      <SearchField
        id={fieldId}
        value={query}
        onChange={onQueryChange}
        label={label}
        inputRef={field}
        className="rounded-full bg-background text-base [&_input]:h-full"
        onKeyDown={(event) => {
          if (event.key === "Escape") onClose()
        }}
      />
    </div>
  )
}

/**
 * The field's way out where the foot has no button of its own to wear the X: the chat list's New button
 * is the pick's toggle and wears the muted cross there (ADR 0141), while a foot given nothing but a
 * search draws one beside it — the same 44px circle, muted so it reads as a way out rather than as the
 * screen's accent, and standing in the slot a thumb already knows.
 */
export function FootSearchClose({ onClose }: { onClose: () => void }) {
  return (
    <Button
      size="icon-lg"
      className="pointer-events-auto size-11 shrink-0 rounded-full bg-muted text-foreground shadow-none hover:bg-muted/80"
      onClick={onClose}
      aria-label="Close search"
      data-search-close
    >
      <XIcon />
    </Button>
  )
}

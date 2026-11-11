import { useEffect, useRef, useState } from "react"
import { MessageCircleIcon, PlusIcon, SearchIcon, UsersIcon, XIcon } from "lucide-react"

import { SearchField } from "@/components/search-field"
import { Button } from "@/components/ui/button"
import { cn } from "@/lib/utils"

/**
 * The field's own name, for the control that shows and hides it — and for the bar's field, which takes
 * the same name because only one of the two is ever in the tree (ADR 0145).
 */
export const CHATS_SEARCH_FIELD_ID = "chats-search"

/** The picks' own name, for the control that shows and hides them. */
const PICKS_ID = "new-picks"

/**
 * The bar a list keeps at the foot of its scroll (see GLOSSARY: foot): the search at the left, where a
 * thumb reaches without crossing the list, and the one button the screen spends at the right. It keeps
 * its place in the flow (`sticky`, not `fixed`), so the last row ends above it and is reachable rather
 * than hidden behind it.
 *
 * **The search is the foot's, at every width.** The circle becomes a field as tall as the button
 * beside it, in the same row, so nothing above the foot moves when it opens, and its ways out are
 * Escape and the muted X the button wears while the field is up — a press outside does not close it,
 * because the reader is typing in it.
 *
 * **The button at the right is the pick itself** (ADR 0141): a `+` while it is closed, an X while its
 * two actions stand above it as pills — one line each, New chat nearest the thumb and New room above it
 * where the Host advertises one — and the muted X while the search holds the foot. The pills stay
 * mounted and inert while closed, so the rise and its quiet fade both play (transitions-dev's texts
 * reveal); they hang above the button rather than in the foot's box, so an open cluster never resizes
 * the bar under the reader's thumb. Pressing the button, pressing anywhere else, or Escape closes the
 * picks, and every way out returns the focus to the button.
 *
 * The foot owns its own controls — their refs, what each opens, and where the focus goes when
 * something closes — so the screen it sits on is the list and the rows, not the bar's machinery.
 */
export function ListFoot({
  canMakeRoom,
  searchable,
  query,
  onQueryChange,
  onNewChat,
  onNewRoom,
}: {
  canMakeRoom: boolean
  /** Whether the search is this bar's to offer: from the laptop width up the bar's own field holds it. */
  searchable: boolean
  /** The words the list is narrowed by. The foot holds whether its field is up; the screen holds what
   * the field asked for, since the rows are the screen's. */
  query: string
  onQueryChange: (query: string) => void
  onNewChat: () => void
  onNewRoom: () => void
}) {
  // One value, three states: the foot shows the search, the picks, or neither — never two of them,
  // and no pair of booleans that could both be true (ADR 0141).
  const [surface, setSurface] = useState<"closed" | "picks" | "search">("closed")
  const open = surface === "picks"
  const searching = searchable && surface === "search"
  // The exit is one quiet fade, played while the pills are already inert: the class is what starts it,
  // and it is taken off again once it has run.
  const [hiding, setHiding] = useState(false)
  const searchToggle = useRef<HTMLButtonElement>(null)
  const newToggle = useRef<HTMLButtonElement>(null)
  const field = useRef<HTMLInputElement>(null)

  const closePicks = () => {
    setSurface("closed")
    window.requestAnimationFrame(() => newToggle.current?.focus())
  }
  const togglePicks = () => (open ? closePicks() : setSurface("picks"))
  // Closing the field takes its words with it: a list narrowed by a query nobody can see reads as a
  // list that lost rows.
  const closeSearch = () => {
    setSurface("closed")
    onQueryChange("")
    window.requestAnimationFrame(() => searchToggle.current?.focus())
  }

  // The field takes the focus as it takes the circle's place, and the circle takes it back when the
  // field goes.
  useEffect(() => {
    if (!searching) return
    window.requestAnimationFrame(() => field.current?.focus())
  }, [searching])

  useEffect(() => {
    if (open) {
      setHiding(false)
      return
    }
    setHiding(true)
    const timer = window.setTimeout(() => setHiding(false), 200)
    return () => window.clearTimeout(timer)
  }, [open])

  useEffect(() => {
    if (!open) return
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") closePicks()
    }
    document.addEventListener("keydown", onKey)
    return () => document.removeEventListener("keydown", onKey)
  }, [open])

  return (
    <div
      data-slot="list-foot"
      className="pointer-events-none sticky bottom-0 z-20 mt-auto bg-gradient-to-t from-background via-background/90 to-transparent px-4 pt-6 pb-[max(1rem,env(safe-area-inset-bottom))]"
    >
      <div
        className={cn(
          "mx-auto flex w-full max-w-2xl items-center gap-2",
          // Where the bar holds the search, the New cluster is the row's only control and keeps its
          // right edge, which is the slot a thumb finds it in at every width.
          searchable ? "justify-between" : "justify-end",
        )}
      >
        {searching ? (
          <div className="pointer-events-auto min-w-0 flex-1">
            <SearchField
              id={CHATS_SEARCH_FIELD_ID}
              value={query}
              // An empty field is a search that found everything, not a reason to shut: Escape and the
              // X are the two ways this closes, so backspacing the last character — or the field's own
              // clear control — keeps the focus and the keyboard where the reader is.
              onChange={onQueryChange}
              label="Search chats"
              inputRef={field}
              className="rounded-full bg-background text-base [&_input]:h-full"
              onKeyDown={(event) => {
                if (event.key === "Escape") closeSearch()
              }}
            />
          </div>
        ) : searchable ? (
          <Button
            ref={searchToggle}
            variant="outline"
            size="icon-lg"
            className="pointer-events-auto size-11 shrink-0 rounded-full bg-background shadow-lg"
            // A keyboard reaches this while the picks are up, where a tap cannot; one state means the
            // field simply takes their place.
            onClick={() => setSurface("search")}
            aria-label="Search"
            data-search-toggle
          >
            <SearchIcon />
          </Button>
        ) : null}

        <div className="relative flex shrink-0 flex-col items-end">
          {/*
            The picks have no scrim of their own, so the foot lays one: a press meant for a row closes
            them instead of opening the row behind them.
          */}
          {open && (
            <button
              type="button"
              tabIndex={-1}
              aria-hidden
              className="pointer-events-auto fixed inset-0 cursor-default"
              onClick={closePicks}
            />
          )}
          <div
            id={PICKS_ID}
            data-picks
            data-toast-above={open || undefined}
            aria-hidden={!open}
            inert={!open}
            className={cn(
              "t-stagger pointer-events-auto absolute right-0 bottom-full z-10 mb-2 flex flex-col items-end gap-2",
              open && "is-shown",
              hiding && "is-hiding",
            )}
          >
            {canMakeRoom && (
              <button
                type="button"
                aria-label="New room"
                onClick={() => {
                  closePicks()
                  onNewRoom()
                }}
                className="t-stagger-line t-stagger-line--2 inline-flex h-11 items-center gap-2 rounded-full border border-border bg-background px-4 text-sm font-medium whitespace-nowrap shadow-lg outline-none hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring"
              >
                <UsersIcon aria-hidden className="size-5 text-muted-foreground" />
                New room
              </button>
            )}
            <button
              type="button"
              aria-label="New chat"
              onClick={() => {
                closePicks()
                onNewChat()
              }}
              className="t-stagger-line inline-flex h-11 items-center gap-2 rounded-full border border-border bg-background px-4 text-sm font-medium whitespace-nowrap shadow-lg outline-none hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring"
            >
              <MessageCircleIcon aria-hidden className="size-5 text-muted-foreground" />
              New chat
            </button>
          </div>
          <Button
            ref={newToggle}
            data-toast-above
            data-new-menu
            data-search-close={searching || undefined}
            size="icon-lg"
            className={cn(
              "pointer-events-auto relative z-10 size-11 shrink-0 rounded-full",
              searching ? "bg-muted text-foreground shadow-none hover:bg-muted/80" : "shadow-lg",
            )}
            onClick={() => (searching ? closeSearch() : togglePicks())}
            aria-label={searching ? "Close search" : open ? "Close" : "New"}
            aria-expanded={searching ? undefined : open}
            aria-controls={searching ? undefined : PICKS_ID}
          >
            {/* transitions-dev's icon swap: both faces in one cell, the state picks which shows. */}
            <span aria-hidden className="t-icon-swap" data-state={searching || open ? "b" : "a"}>
              <PlusIcon className="t-icon" data-icon="a" />
              <XIcon className="t-icon" data-icon="b" />
            </span>
          </Button>
        </div>
      </div>
    </div>
  )
}

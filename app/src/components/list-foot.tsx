import { useRef, useState, type ReactNode } from "react"
import { MessageCircleIcon, PlusIcon, SearchIcon, UsersIcon } from "lucide-react"

import { Popup, PopupContent, PopupHeader, PopupTitle } from "@/components/popup"
import { Button } from "@/components/ui/button"

/** The field's own name, for the control that shows and hides it. */
export const CHATS_SEARCH_FIELD_ID = "chats-search"

/**
 * The bar a list keeps at the foot of its scroll (see GLOSSARY: foot): the search control at the left,
 * where a thumb reaches without crossing the list, and the one accent the screen spends at the right.
 * It keeps its place in the flow (`sticky`, not `fixed`), so the last row ends above it and is
 * reachable rather than hidden behind it.
 *
 * The foot owns its own controls — their refs, what each opens, and where the focus goes when
 * something closes — so the screen it sits on is the list and the rows, not the bar's machinery. The
 * search's field is still the screen's while it stands over the rows; it moves into the foot with its
 * state (ADR 0141).
 */
export function ListFoot({
  canMakeRoom,
  searching,
  onSearchOpen,
  onSearchClose,
  onNewChat,
  onNewRoom,
}: {
  canMakeRoom: boolean
  searching: boolean
  onSearchOpen: () => void
  onSearchClose: () => void
  onNewChat: () => void
  onNewRoom: () => void
}) {
  const [starting, setStarting] = useState(false)
  const searchToggle = useRef<HTMLButtonElement>(null)
  const newToggle = useRef<HTMLButtonElement>(null)

  // A closed search leaves the reader on the control that closed it, where they pressed.
  const closeSearch = () => {
    onSearchClose()
    window.requestAnimationFrame(() => searchToggle.current?.focus())
  }

  return (
    <>
      <div
        data-slot="list-foot"
        className="pointer-events-none sticky bottom-0 z-20 mt-auto bg-gradient-to-t from-background via-background/90 to-transparent px-4 pt-6 pb-[max(1rem,env(safe-area-inset-bottom))]"
      >
        <div className="mx-auto flex w-full max-w-2xl items-center justify-between gap-2">
          <Button
            ref={searchToggle}
            variant="outline"
            size="icon-lg"
            className="pointer-events-auto size-14 shrink-0 rounded-full bg-background shadow-lg"
            onClick={() => (searching ? closeSearch() : onSearchOpen())}
            aria-label="Search"
            aria-expanded={searching}
            aria-controls={searching ? CHATS_SEARCH_FIELD_ID : undefined}
            data-search-toggle
          >
            <SearchIcon className="size-5" />
          </Button>
          <Button
            ref={newToggle}
            data-toast-above
            data-new-menu
            size="icon-lg"
            className="pointer-events-auto size-14 shrink-0 rounded-full shadow-lg"
            onClick={() => setStarting(true)}
            aria-label="New"
          >
            <PlusIcon className="size-6" />
          </Button>
        </div>
      </div>

      {/* A one-tap pick from the button above it (ADR 0141 retires it for this foot's next step). */}
      <Popup open={starting} onOpenChange={setStarting} anchor={newToggle}>
        <PopupContent size="md" toastAbove>
          <PopupHeader>
            <PopupTitle>New</PopupTitle>
          </PopupHeader>
          <div className="flex flex-col gap-1 px-2 pb-2">
            <NewRow
              icon={<MessageCircleIcon />}
              label="New chat"
              detail="A chat with this bot"
              onPick={() => {
                setStarting(false)
                onNewChat()
              }}
            />
            {canMakeRoom && (
              <NewRow
                icon={<UsersIcon />}
                label="New room"
                detail="Bring other bots into one chat"
                onPick={() => {
                  setStarting(false)
                  onNewRoom()
                }}
              />
            )}
          </div>
        </PopupContent>
      </Popup>
    </>
  )
}

/**
 * One row of the new menu: what it starts, and what that is, as a full-width target a thumb hits at
 * either form — a sheet's row on a phone, a menu's row beside the button from 1024px.
 */
function NewRow({
  icon,
  label,
  detail,
  onPick,
}: {
  icon: ReactNode
  label: string
  detail: string
  onPick: () => void
}) {
  return (
    <button
      type="button"
      // The name is the action alone: the detail is the line under it, not part of what it is called.
      aria-label={label}
      onClick={onPick}
      className="flex min-h-14 w-full items-center gap-3 rounded-xl px-3 py-2 text-left text-[15px] outline-none hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring"
    >
      <span aria-hidden className="shrink-0 text-muted-foreground [&_svg]:size-5">
        {icon}
      </span>
      <span className="flex min-w-0 flex-1 flex-col">
        <span className="truncate">{label}</span>
        <span className="text-sm text-muted-foreground">{detail}</span>
      </span>
    </button>
  )
}

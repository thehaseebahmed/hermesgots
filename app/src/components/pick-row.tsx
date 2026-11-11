/**
 * The row a pop-up offers, and the list it sits in.
 *
 * A pick is one control wherever a sheet, a drawer or a popover offers a list: one mark, a name with
 * at most one muted line under it, a tick on the row that is chosen, a chevron on the row that goes
 * somewhere, and a grey cursor on the row the keyboard is walking. Seven of those lists were drawn by
 * hand before this — with two heights, two selection tones and four different ideas of what a row's
 * state means — so the anatomy and the state live here and a caller passes only what its rows say
 * and what a pick means.
 *
 * The group carries the mode, because a row is not a radio outside a radiogroup: the list decides
 * what its rows are, and a row that carried its own mode could put `role="option"` inside one.
 * A row with no group is an `open` row: the only promise a list can make without neighbours.
 */
import { createContext, useContext, type CSSProperties, type ReactNode } from "react"
import { CheckIcon, ChevronRightIcon } from "lucide-react"

import { Button } from "@/components/ui/button"
import { cn } from "@/lib/utils"

/** What this list's rows are: one of several, each on its own, a way out, or a cursor to run. */
export type PickMode = "choose" | "toggle" | "open" | "option"

const Surface = createContext<{ mode: PickMode; plate: boolean }>({ mode: "open", plate: false })

/**
 * The list itself: a bare `<ul>` on the popover, or the muted plate three pop-ups group two or more
 * lists on. `heading` is both the words above it and, unless `label` says otherwise, its name.
 */
export function PickGroup({
  mode,
  surface = "bare",
  heading,
  label,
  id,
  className,
  style,
  children,
}: {
  mode: PickMode
  surface?: "plate" | "bare"
  heading?: string
  /** What the list is called where the heading would name the wrong thing. */
  label?: string
  /** The list's own id, for the field that points at its options. */
  id?: string
  /** Layout only: a scroll, a max height, a gap. */
  className?: string
  /** The one thing a class cannot say: a room measured in pixels. */
  style?: CSSProperties
  children: ReactNode
}) {
  const plate = surface === "plate"
  const role = mode === "option" ? "listbox" : mode === "choose" ? "radiogroup" : undefined
  const list = (
    <ul
      id={id}
      role={role}
      aria-label={label ?? heading}
      style={style}
      className={cn(
        plate && "flex flex-col overflow-hidden rounded-2xl bg-muted/60 p-1",
        className,
      )}
    >
      <Surface.Provider value={{ mode, plate }}>{children}</Surface.Provider>
    </ul>
  )
  if (!heading) return list
  return (
    <section className="flex flex-col gap-2">
      <h3 className="px-1 text-sm text-muted-foreground">{heading}</h3>
      {list}
    </section>
  )
}

/**
 * One row: an `<li>` holding one button and, where the caller has an action of its own, one button
 * beside it — never inside it, since a button inside a button cannot be pressed by a screen reader.
 */
export function PickRow({
  leading,
  title,
  line,
  selected = false,
  active = false,
  disabled,
  label,
  id,
  onPick,
  onActive,
  action,
  data,
}: {
  /** The mark: a disc, a picture or an icon, drawn in the one 32px column every title starts after. */
  leading?: ReactNode
  title: ReactNode
  /** One muted line under the name. Its presence is what makes a row taller than 44px. */
  line?: ReactNode
  selected?: boolean
  /** The keyboard cursor, which is not the same fact as `selected`. */
  active?: boolean
  disabled?: boolean
  /** The button's name where the title alone reads as nothing to press. */
  label?: string
  /** An id on the button, which is where a listbox's `aria-activedescendant` has to point. */
  id?: string
  onPick?: () => void
  onActive?: () => void
  /** A second button beside the pick: a pencil, a stop, a way in. */
  action?: { label: string; icon?: ReactNode; onPress: () => void; disabled?: boolean }
  /** The `data-` attribute a flow reads, on the item rather than the button. */
  data?: Record<string, string>
}) {
  const { mode, plate } = useContext(Surface)
  const stateful = mode === "choose" || mode === "toggle"
  return (
    <li
      role={mode === "choose" || mode === "option" ? "none" : undefined}
      className={cn(action && "flex items-center gap-1")}
      {...data}
      onMouseMove={onActive}
    >
      <button
        type="button"
        id={id}
        role={mode === "choose" ? "radio" : mode === "option" ? "option" : undefined}
        aria-checked={mode === "choose" ? selected : undefined}
        aria-pressed={mode === "toggle" ? selected : undefined}
        aria-selected={mode === "option" ? active : undefined}
        aria-label={label}
        disabled={disabled}
        // Keep the keyboard where the list was summoned from while the pointer passes over it.
        onMouseDown={mode === "option" ? (event) => event.preventDefault() : undefined}
        onClick={onPick}
        className={cn(
          "flex w-full min-h-11 min-w-0 flex-1 items-center gap-3 rounded-xl px-3 py-1.5 text-left outline-none transition-colors focus-visible:ring-3 focus-visible:ring-ring/50 disabled:opacity-50",
          mode === "option"
            ? active && "bg-accent"
            : cn(
                plate ? "hover:bg-background/60" : "hover:bg-muted",
                selected && (plate ? "bg-background" : "bg-muted"),
              ),
        )}
      >
        {leading && (
          <span className="flex size-8 shrink-0 items-center justify-center">{leading}</span>
        )}
        <span className="flex min-w-0 flex-1 flex-col gap-0.5">
          <span className="flex min-w-0 items-center gap-2">{title}</span>
          {line && (
            <span className="min-w-0 truncate text-sm text-muted-foreground">
              {line}
            </span>
          )}
        </span>
        {stateful && selected && (
          <CheckIcon className="size-4 shrink-0 text-primary" aria-hidden />
        )}
        {mode === "open" && (
          <ChevronRightIcon className="size-4 shrink-0 text-muted-foreground" aria-hidden />
        )}
      </button>
      {action && (
        <Button
          type="button"
          variant="ghost"
          size="icon"
          aria-label={action.label}
          disabled={action.disabled}
          className="size-11 shrink-0"
          onClick={action.onPress}
        >
          {action.icon}
        </Button>
      )}
    </li>
  )
}

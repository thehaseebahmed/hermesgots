import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react"

import { ChevronRightIcon, type LucideIcon } from "lucide-react"

import { ExperimentalBadge } from "@/components/experimental-badge"
import { Switch } from "@/components/ui/switch"
import { cn } from "@/lib/utils"

/**
 * The slot a page fills in the header of the Screen holding it, keyed so one page's action replaces
 * another's. Each Screen provides its own, so a page beside its list never reaches the list's head.
 */
const HeaderSlot = createContext<(key: string, draw: (() => ReactNode) | null) => void>(() => {})

/** The chrome every Settings screen wears: a sticky header over one centred column of groups. */
export function Screen({
  title,
  leading,
  action,
  className,
  children,
}: {
  title: string
  leading?: ReactNode
  /** A control at the header's right edge, after the title: the screen's own action. */
  action?: ReactNode
  className?: string
  children: ReactNode
}) {
  const [page, setPage] = useState<{ key: string; draw: () => ReactNode } | null>(null)
  const publish = useCallback((key: string, draw: (() => ReactNode) | null) => {
    setPage(draw ? { key, draw } : null)
  }, [])
  const shown = action ?? page?.draw() ?? null
  return (
    <div className={cn("flex min-h-0 flex-1 flex-col overflow-y-auto", className)}>
      <header className="sticky top-0 z-10 bg-background/80 px-4 pt-[max(0.75rem,env(safe-area-inset-top))] pb-3 backdrop-blur">
        <div className="mx-auto flex min-h-11 max-w-2xl items-center gap-3">
          {leading}
          <h1 className="text-xl font-semibold tracking-tight">{title}</h1>
          {shown && <div className="ml-auto flex min-h-11 shrink-0 items-center">{shown}</div>}
        </div>
      </header>
      <HeaderSlot.Provider value={publish}>
        <div className="mx-auto flex w-full max-w-2xl flex-col gap-4 px-4 pb-[max(2rem,env(safe-area-inset-bottom))]">
          {children}
        </div>
      </HeaderSlot.Provider>
    </div>
  )
}

/**
 * Puts a control in the header of the Screen this page renders under, under `key`: the page owns
 * the slot until it unmounts, and a page that returns nothing takes its control with it. What the
 * header draws is read from a ref whenever the Screen renders, so hand over a node whose handlers
 * are stable (a state setter) — the header does not re-render when the page does.
 */
export function useHeaderAction(key: string, action: ReactNode) {
  const publish = useContext(HeaderSlot)
  const node = useRef(action)
  useEffect(() => {
    node.current = action
  })
  useEffect(() => {
    publish(key, () => node.current)
    return () => publish(key, null)
  }, [publish, key])
}

/** The rounded card list with hairline separators the Settings rows sit in. */
export function Group({ children }: { children: ReactNode }) {
  return (
    <div className="flex flex-col gap-px overflow-hidden rounded-3xl bg-border ring-1 ring-foreground/10 *:rounded-none">
      {children}
    </div>
  )
}

/**
 * A settings group's heading over the line saying what it holds; its Group cards follow as siblings.
 */
export function GroupHeading({ title, subtitle }: { title: ReactNode; subtitle?: ReactNode }) {
  return (
    <div className="flex flex-col px-5">
      <h2 className="text-base font-semibold">{title}</h2>
      {subtitle && <p className="text-sm text-muted-foreground">{subtitle}</p>}
    </div>
  )
}

export const rowClass =
  "flex min-h-14 w-full items-center gap-4 bg-card px-5 py-3 text-left text-card-foreground"
/** `rowClass` for a row that opens something. */
export const linkRowClass = `${rowClass} transition-colors hover:bg-muted`

/** A row's title over its muted second line. */
export function RowText({ title, subtitle }: { title: ReactNode; subtitle?: ReactNode }) {
  return (
    <span className="flex min-w-0 flex-1 flex-col">
      <span className="truncate text-base">{title}</span>
      {subtitle && <span className="line-clamp-2 text-sm text-muted-foreground">{subtitle}</span>}
    </span>
  )
}

/** A row that opens a pop-up of its own: the row chrome, and the open state the sheet takes. */
export function SheetRow({
  icon: Icon,
  title,
  sheet,
}: {
  icon: LucideIcon
  title: string
  sheet: (sheetProps: { open: boolean; onOpenChange: (open: boolean) => void }) => ReactNode
}) {
  const [open, setOpen] = useState(false)
  return (
    <>
      <button type="button" onClick={() => setOpen(true)} className={linkRowClass}>
        <Icon className="size-5 shrink-0 text-muted-foreground" />
        <RowText title={title} />
      </button>
      {sheet({ open, onOpenChange: setOpen })}
    </>
  )
}

/** A row that runs something: the row chrome, its icon, its title, and a chevron like a link's. */
export function ActionRow({
  icon: Icon,
  title,
  onClick,
}: {
  icon: LucideIcon
  title: string
  onClick: () => void
}) {
  return (
    <button type="button" onClick={onClick} className={linkRowClass}>
      <Icon className="size-5 shrink-0 text-muted-foreground" />
      <RowText title={title} />
      <ChevronRightIcon className="size-4 shrink-0 text-muted-foreground" />
    </button>
  )
}

/** The row every Settings switch wears: an icon, a title over a muted line, and the switch. */
export function SwitchRow({
  id,
  icon: Icon,
  title,
  experimental,
  subtitle,
  checked,
  disabled,
  variant,
  onCheckedChange,
}: {
  id: string
  icon: LucideIcon
  title: string
  experimental?: boolean
  subtitle?: string
  checked: boolean
  disabled?: boolean
  /** `header` tops a group of switches it controls; `nested` is one of them. */
  variant?: "header" | "nested"
  onCheckedChange: (checked: boolean) => void
}) {
  return (
    <label
      htmlFor={id}
      className={cn(
        rowClass,
        "cursor-pointer",
        variant === "header" && "bg-muted py-4",
        variant === "nested" && "pl-9",
      )}
    >
      <Icon className="size-5 shrink-0 text-muted-foreground" />
      <span className="flex min-w-0 flex-1 flex-col">
        <span className="flex min-w-0 items-center gap-2">
          <span className={cn("truncate text-base", variant === "header" && "font-semibold")}>
            {title}
          </span>
          {experimental && <ExperimentalBadge />}
        </span>
        {subtitle && <span className="line-clamp-2 text-sm text-muted-foreground">{subtitle}</span>}
      </span>
      <Switch id={id} checked={checked} disabled={disabled} onCheckedChange={onCheckedChange} />
    </label>
  )
}

/**
 * A row that both opens something and toggles: two fully clickable columns, the left doing the tap
 * and the right the switch, so turning a setting on never opens the screen behind it.
 */
export function SplitSwitchRow({
  icon: Icon,
  title,
  subtitle,
  extra,
  switchLabel,
  checked,
  disabled,
  onOpen,
  onCheckedChange,
}: {
  icon?: LucideIcon
  title: string
  subtitle?: ReactNode
  /** Extra lines under the subtitle, still inside the clickable left column (a skill's health line). */
  extra?: ReactNode
  /** The switch's own accessible name; defaults to `title`. */
  switchLabel?: string
  checked: boolean
  disabled?: boolean
  onOpen: () => void
  onCheckedChange: (checked: boolean) => void
}) {
  return (
    <div className={cn(rowClass, "gap-0 p-0")}>
      <button
        type="button"
        onClick={onOpen}
        className="flex min-h-14 min-w-0 flex-1 items-center gap-4 px-5 py-3 text-left transition-colors hover:bg-muted"
      >
        {Icon && <Icon className="size-5 shrink-0 text-muted-foreground" />}
        <span className="flex min-w-0 flex-1 flex-col">
          <RowText title={title} subtitle={subtitle} />
          {extra}
        </span>
      </button>
      {/* The label holds only the switch, so a tap here toggles and never reaches the column beside
          it. Its words are hidden: the switch's element is a span, which takes its name from the
          label it sits in, and without them the name is empty. */}
      <label className="flex min-h-14 shrink-0 cursor-pointer items-center px-5 py-3">
        <span className="sr-only">{switchLabel ?? title}</span>
        <Switch
          aria-label={switchLabel ?? title}
          checked={checked}
          disabled={disabled}
          onCheckedChange={onCheckedChange}
        />
      </label>
    </div>
  )
}

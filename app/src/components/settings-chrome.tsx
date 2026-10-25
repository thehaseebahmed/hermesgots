import { useState, type ReactNode } from "react"

import { ChevronRightIcon, type LucideIcon } from "lucide-react"

import { ExperimentalBadge } from "@/components/experimental-badge"
import { Switch } from "@/components/ui/switch"
import { cn } from "@/lib/utils"

/** The chrome every Settings screen wears: a sticky header over one centred column of groups. */
export function Screen({
  title,
  leading,
  className,
  children,
}: {
  title: string
  leading?: ReactNode
  className?: string
  children: ReactNode
}) {
  return (
    <div className={cn("flex min-h-0 flex-1 flex-col overflow-y-auto", className)}>
      <header className="sticky top-0 z-10 bg-background/80 px-4 pt-[max(0.75rem,env(safe-area-inset-top))] pb-3 backdrop-blur">
        <div className="mx-auto flex min-h-11 max-w-2xl items-center gap-3">
          {leading}
          <h1 className="text-xl font-semibold tracking-tight">{title}</h1>
        </div>
      </header>
      <div className="mx-auto flex w-full max-w-2xl flex-col gap-4 px-4 pb-[max(2rem,env(safe-area-inset-bottom))]">
        {children}
      </div>
    </div>
  )
}

/** The rounded card list with hairline separators the Settings rows sit in. */
export function Group({ children }: { children: ReactNode }) {
  return (
    <div className="flex flex-col gap-px overflow-hidden rounded-3xl bg-border ring-1 ring-foreground/10 *:rounded-none">
      {children}
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

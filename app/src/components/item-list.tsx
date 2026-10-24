import type { ReactNode } from "react"
import { ChevronUpIcon, SearchIcon, XIcon } from "lucide-react"
import { Link } from "react-router"

import { Bot } from "@/components/bot"
import {
  InputGroup,
  InputGroupAddon,
  InputGroupButton,
  InputGroupInput,
} from "@/components/ui/input-group"
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible"
import type { CodeGroupKey, ItemGroupKey } from "@/lib/item-groups"
import type { RowTone } from "@/lib/session-work"
import { cn } from "@/lib/utils"

/**
 * A titled group of rows with its count; Closed starts folded. `sticky` pins the heading under the
 * screen's own header while the group scrolls (Code's four): the header publishes its height as
 * `--list-header-h` on the list's scroll container, and the heading stops beneath it.
 */
export function ItemGroup({
  group,
  sticky,
  children,
}: {
  group: { key: ItemGroupKey | CodeGroupKey; label: string; items: unknown[] }
  sticky?: boolean
  children: ReactNode
}) {
  const heading = (
    <>
      {group.label}
      <span
        className={cn(
          "rounded-full px-1.5 text-xs leading-5 font-semibold tabular-nums",
          group.key === "waiting" ? TONES.warning : TONES.muted,
        )}
      >
        {group.items.length}
      </span>
    </>
  )
  const at = sticky ? "sticky z-[5] bg-background top-[var(--list-header-h)]" : ""
  const list = <ul className="flex flex-col">{children}</ul>
  if (group.key !== "closed")
    return (
      <section className="flex flex-col gap-1" aria-label={group.label}>
        <h2
          className={cn(
            "flex min-h-8 items-center gap-2 px-1 text-sm font-medium text-muted-foreground",
            at,
          )}
        >
          {heading}
        </h2>
        {list}
      </section>
    )
  return (
    <Collapsible
      defaultOpen={false}
      render={<section className="flex flex-col gap-1" aria-label={group.label} />}
    >
      <h2>
        <CollapsibleTrigger
          className={cn(
            "group -mx-1 flex min-h-11 items-center gap-2 rounded-xl px-2 text-sm font-medium text-muted-foreground outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring",
            at,
          )}
        >
          {heading}
          <ChevronUpIcon className="size-4 rotate-180 transition-transform group-data-panel-open:rotate-0 motion-reduce:transition-none" />
        </CollapsibleTrigger>
      </h2>
      <CollapsibleContent>{list}</CollapsibleContent>
    </Collapsible>
  )
}

/** The icon's three tones, whichever list picks them. */
const TONES: Record<RowTone, string> = {
  warning: "bg-warning/15 text-warning",
  success: "bg-primary/10 text-primary",
  muted: "bg-muted text-muted-foreground",
}

/**
 * One row of a list: the feature's icon with the bot in its corner, the title and time, one status
 * line, and anything below it. The open item is tinted.
 */
export function ItemRow({
  icon,
  tone,
  unread,
  botId,
  title,
  badge,
  when,
  line,
  warn,
  children,
  selected,
  onOpen,
  link,
}: {
  icon: ReactNode
  /**
   * The icon's colour, when the list picks it per row (Code: warning for what waits, success for
   * done or healthy, muted for at rest).
   */
  tone?: RowTone
  /** New activity since this device last rendered the thread: the blue dot on the icon's corner. */
  unread?: boolean
  botId?: string
  title: string
  /** A mark beside the title, for what the row is rather than what it's doing. */
  badge?: ReactNode
  when?: string
  line?: ReactNode
  /** The status line reads as a warning (a failed step). */
  warn?: boolean
  children?: ReactNode
  selected?: boolean
  onOpen?: () => void
  link?: { to: string; replace?: boolean; state?: unknown }
}) {
  const className = cn(
    "-mx-2 flex min-h-16 w-[calc(100%+1rem)] items-start gap-3 rounded-2xl px-2 py-3 text-left outline-none hover:bg-muted/60 focus-visible:ring-2 focus-visible:ring-ring",
    selected && "bg-muted hover:bg-muted",
  )
  const body = (
    <>
      <span className="relative mt-0.5 shrink-0">
        <span
          className={cn(
            "flex size-10 items-center justify-center rounded-full [&_svg]:size-5",
            tone ? TONES[tone] : TONES.success,
          )}
        >
          {icon}
        </span>
        {botId && (
          <span className="absolute -right-1 -bottom-1 flex size-5 items-center justify-center overflow-hidden rounded-full bg-background ring-2 ring-background">
            <Bot id={botId} className="size-[85%]" />
          </span>
        )}
        {unread && (
          <>
            <span className="sr-only">New activity</span>
            <span
              data-unread
              aria-hidden
              className="absolute -top-0.5 -right-0.5 size-2.5 rounded-full bg-info ring-2 ring-background"
            />
          </>
        )}
      </span>
      <span className="flex min-w-0 flex-1 flex-col gap-1">
        <span className="flex items-baseline gap-2">
          <span className="min-w-0 flex-1 truncate font-medium">{title}</span>
          {badge}
          {when && <span className="shrink-0 text-xs text-muted-foreground">{when}</span>}
        </span>
        {line && (
          <span
            className={cn(
              "flex min-w-0 items-center gap-1.5 text-sm text-muted-foreground",
              warn && "text-warning",
            )}
          >
            {line}
          </span>
        )}
        {children}
      </span>
    </>
  )
  if (link)
    return (
      <Link
        to={link.to}
        replace={link.replace}
        state={link.state}
        aria-current={selected ? "page" : undefined}
        className={className}
      >
        {body}
      </Link>
    )
  return (
    <button
      type="button"
      onClick={onOpen}
      aria-current={selected || undefined}
      className={className}
    >
      {body}
    </button>
  )
}

/** The search field at the top of a list. */
export function ItemSearch({
  value,
  onChange,
  label,
}: {
  value: string
  onChange: (value: string) => void
  label: string
}) {
  return (
    <InputGroup className="h-11 rounded-full bg-background dark:bg-input/30">
      <InputGroupAddon>
        <SearchIcon />
      </InputGroupAddon>
      <InputGroupInput
        type="search"
        value={value}
        onChange={(event) => onChange(event.target.value)}
        placeholder={label}
        aria-label={label}
        autoComplete="off"
        className="[&::-webkit-search-cancel-button]:hidden"
      />
      {value && (
        <InputGroupAddon align="inline-end">
          <InputGroupButton
            size="icon-sm"
            className="size-8 rounded-full"
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

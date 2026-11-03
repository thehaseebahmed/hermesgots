/**
 * The app's line for something that happened rather than something said: a muted sentence under or
 * above a message, with the one thing it names as a link in the info blue — "Moved to “…”", and a
 * routine's "Ran “Morning watch” in 12s". Both read as the app talking about the thread rather than
 * as the bot speaking in it, so both are this line: one size, one tone, one target, and one place to
 * change them.
 */
import type { MouseEvent, ReactNode } from "react"
import { Link } from "react-router"
import type { LucideIcon } from "lucide-react"

import { cn } from "@/lib/utils"

/**
 * The line itself: full width and 44px tall, so the whole sentence is a thumb's target even though
 * only its link answers a press — the shape the Moved marker has always had.
 */
export function SystemLine({ children, className }: { children?: ReactNode; className?: string }) {
  return (
    <p className={cn("min-h-11 py-3 text-sm leading-5 text-muted-foreground", className)}>
      {children}
    </p>
  )
}

/**
 * What a line names: the one part of it that goes somewhere, in the info blue with its own mark —
 * a chat's name, or the run that wrote the words below.
 */
export function SystemLink({
  icon: Icon,
  to,
  state,
  onClick,
  label,
  children,
}: {
  icon: LucideIcon
  /** Where it goes, when it goes somewhere in the app. */
  to?: string
  state?: unknown
  /** What it does instead, when it opens something over the thread, or where it must not leave. */
  onClick?: (event: MouseEvent<HTMLAnchorElement & HTMLButtonElement>) => void
  /** What the link is, for a reader who can't see the sentence around it. */
  label?: string
  children: ReactNode
}) {
  const body = (
    <>
      <Icon className="mr-1 inline size-3.5 align-[-2px]" aria-hidden />
      {children}
    </>
  )
  const className =
    "font-medium text-info underline-offset-2 outline-none hover:underline focus-visible:underline"
  if (to)
    return (
      <Link to={to} state={state} onClick={onClick} aria-label={label} className={className}>
        {body}
      </Link>
    )
  return (
    <button type="button" onClick={onClick} aria-label={label} className={className}>
      {body}
    </button>
  )
}

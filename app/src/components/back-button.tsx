import { ArrowLeftIcon } from "lucide-react"
import { Link } from "react-router"
import type { ReactNode } from "react"

import { Button } from "@/components/ui/button"
import { cn } from "@/lib/utils"

/**
 * The round control a header leads back with. A destination makes it a link: a screen an address
 * opened has no history behind it, and back from the first entry leaves the app rather than going
 * anywhere sensible (`lib/nav.ts`). A press is for a pushed screen, whose way back is the step its
 * own `up()` names. `floating` is a header's, for one that covers what it scrolls over. `icon` is
 * what the control leads with, for a slot whose move is a different one: a thread put away leads
 * with a cross, in the place a phone's Back sits.
 */
export function BackButton({
  label,
  to,
  onClick,
  floating,
  variant = "outline",
  icon = <ArrowLeftIcon />,
}: {
  label: string
  to?: string
  onClick?: () => void
  floating?: boolean
  /** `ghost` for a header whose neighbours carry no edge, as a canvas's does. */
  variant?: "outline" | "ghost"
  icon?: ReactNode
}) {
  const look = cn("size-11 shrink-0 rounded-full", floating && "bg-background/80 backdrop-blur")
  return (
    <Button
      variant={variant}
      size="icon-lg"
      className={look}
      nativeButton={!to}
      render={to ? <Link to={to} aria-label={label} /> : undefined}
      onClick={onClick}
      aria-label={label}
    >
      {icon}
    </Button>
  )
}

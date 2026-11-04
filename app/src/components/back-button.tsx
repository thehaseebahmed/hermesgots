import { ArrowLeftIcon } from "lucide-react"
import { Link } from "react-router"

import { Button } from "@/components/ui/button"
import { cn } from "@/lib/utils"

/**
 * The round control a header leads back with. A destination makes it a link: a screen an address
 * opened has no history behind it, and back from the first entry leaves the app rather than going
 * anywhere sensible (`lib/nav.ts`). A press is for a pushed screen, whose way back is the step its
 * own `up()` names. `floating` is a header's, for one that covers what it scrolls over.
 */
export function BackButton({
  label,
  to,
  onClick,
  floating,
}: {
  label: string
  to?: string
  onClick?: () => void
  floating?: boolean
}) {
  const look = cn("size-11 shrink-0 rounded-full", floating && "bg-background/80 backdrop-blur")
  return (
    <Button
      variant="outline"
      size="icon-lg"
      className={look}
      nativeButton={!to}
      render={to ? <Link to={to} aria-label={label} /> : undefined}
      onClick={onClick}
      aria-label={label}
    >
      <ArrowLeftIcon />
    </Button>
  )
}

import { ChevronsLeftIcon } from "lucide-react"

import { Button } from "@/components/ui/button"

/**
 * The thread open beside Main, put away: a collapse chevron in the header's leading slot, where a
 * phone's Back sits, wearing the Back's own look — leaving a thread reads the same at every width,
 * and only what leaving means changes (ADR 0110).
 */
export function CloseThreadButton({ onClick }: { onClick: () => void }) {
  return (
    <Button
      variant="outline"
      size="icon-lg"
      className="size-11 shrink-0 rounded-full bg-background/80 backdrop-blur"
      onClick={onClick}
      aria-label="Close thread"
    >
      <ChevronsLeftIcon />
    </Button>
  )
}

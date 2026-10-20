import { FolderOpenIcon } from "lucide-react"

import { PILL } from "@/components/chat/pill"
import { Button } from "@/components/ui/button"
import { cn } from "@/lib/utils"

/**
 * The files a session filed in its library as a pill above the composer ("3 outputs"). Tapping it
 * opens the session's outputs drawer, where they are listed beside its pull requests.
 */
export function LibraryPill({
  count,
  onClick,
  className,
}: {
  count: number
  onClick?: () => void
  className?: string
}) {
  return (
    <Button
      type="button"
      variant="secondary"
      className={cn(PILL, "tabular-nums", className)}
      onClick={onClick}
      aria-label={`Outputs (${count})`}
    >
      <FolderOpenIcon className="size-4" />
      {count} {count === 1 ? "output" : "outputs"}
    </Button>
  )
}

import { FolderOpenIcon } from "lucide-react"

import { Button } from "@/components/ui/button"
import { cn } from "@/lib/utils"

/**
 * The files a session filed in its library as a pill above the composer ("3 outputs"). Static for
 * now: it says there is something to find on the project's Library tab.
 */
export function LibraryPill({ count, className }: { count: number; className?: string }) {
  return (
    <Button
      type="button"
      variant="secondary"
      className={cn("h-11 shrink-0 gap-2 rounded-full px-4 tabular-nums", className)}
    >
      <FolderOpenIcon className="size-4" />
      {count} {count === 1 ? "output" : "outputs"}
    </Button>
  )
}

import { FolderOpenIcon } from "lucide-react"

import { cn } from "@/lib/utils"

/**
 * The files a session filed in its library as a pill above the composer ("3 outputs"). Static for
 * now: it says there is something to find on the project's Library tab.
 */
export function LibraryPill({ count, className }: { count: number; className?: string }) {
  return (
    <span
      className={cn(
        "inline-flex h-11 shrink-0 items-center gap-2 rounded-full bg-secondary px-4 text-sm font-medium tabular-nums text-secondary-foreground",
        className,
      )}
    >
      <FolderOpenIcon className="size-4" />
      {count} {count === 1 ? "output" : "outputs"}
    </span>
  )
}

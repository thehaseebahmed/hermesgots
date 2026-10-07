import { FolderGit2Icon, GitBranchIcon, GitBranchPlusIcon } from "lucide-react"

import { cn } from "@/lib/utils"
import type { RepoRef } from "@/lib/workspace"

/**
 * Repos as chips, each with its branch when known. They wrap, or with `line` stay on one line,
 * centred, that scrolls when it's wider than the screen.
 */
export function RepoChips({
  repos,
  line,
  className,
}: {
  repos: RepoRef[]
  line?: boolean
  className?: string
}) {
  if (!repos.length) return null
  const list = (
    <ul
      className={cn(
        "flex justify-center gap-2",
        line ? "mx-auto w-max max-w-none min-w-full shrink-0" : "flex-wrap",
        !line && className,
      )}
    >
      {repos.map((repo) => {
        const Branch = repo.base ? GitBranchPlusIcon : GitBranchIcon
        return (
          <li
            key={repo.name}
            className="flex h-8 max-w-full min-w-0 shrink-0 items-center gap-1.5 rounded-full bg-muted px-3 text-sm"
          >
            <FolderGit2Icon className="size-4 shrink-0 text-muted-foreground" />
            <span className="min-w-0 truncate">{repo.name}</span>
            {repo.branch && (
              <span className="flex min-w-0 shrink items-center gap-1 text-muted-foreground">
                <Branch className="size-3.5 shrink-0" aria-hidden />
                <span className="sr-only">{repo.base ? "new branch from" : "on"}</span>
                <span className="truncate">{repo.branch}</span>
              </span>
            )}
          </li>
        )
      })}
    </ul>
  )
  if (!line) return list
  return (
    <div
      className={cn(
        "flex [scrollbar-width:none] overflow-x-auto [&::-webkit-scrollbar]:hidden",
        className,
      )}
    >
      {list}
    </div>
  )
}

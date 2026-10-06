import { useState } from "react"
import { CheckIcon } from "lucide-react"

import { Popup, PopupContent, PopupHeader, PopupTitle } from "@/components/popup"
import { Button } from "@/components/ui/button"
import type { HermesProject, HermesProjectFolder } from "@/lib/hermes"
import { cn } from "@/lib/utils"

function folderName(folder: HermesProjectFolder) {
  return folder.label ?? folder.path.split(/[\\/]/).filter(Boolean).at(-1) ?? folder.path
}

/** Picks which of a project's repos a new session works in. */
export function NewSessionPopup({
  open,
  onOpenChange,
  project,
  onPick,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  project: HermesProject
  onPick: (repoRoot: string) => void
}) {
  const repos = project.folders.filter((folder) => folder.git)
  const [picked, setPicked] = useState(repos[0]?.path)

  return (
    <Popup open={open} onOpenChange={onOpenChange}>
      <PopupContent>
        <PopupHeader className="items-center pb-2">
          <PopupTitle>New session</PopupTitle>
        </PopupHeader>
        <div className="flex flex-col gap-4 px-4 pb-[max(1rem,env(safe-area-inset-bottom))]">
          <ul className="flex flex-col gap-1" role="radiogroup" aria-label="Repository">
            {repos.map((folder) => {
              const on = folder.path === picked
              return (
                <li key={folder.path}>
                  <button
                    type="button"
                    role="radio"
                    aria-checked={on}
                    onClick={() => setPicked(folder.path)}
                    className="flex min-h-11 w-full items-center gap-3 rounded-xl px-3 py-2 text-left outline-none hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring"
                  >
                    <span
                      className={cn(
                        "flex size-5 shrink-0 items-center justify-center rounded-full border",
                        on && "border-primary bg-primary text-primary-foreground",
                      )}
                    >
                      {on && <CheckIcon className="size-3.5" />}
                    </span>
                    <span className="flex min-w-0 flex-col">
                      <span className="truncate text-sm font-medium">{folderName(folder)}</span>
                      <span className="truncate text-xs text-muted-foreground">{folder.path}</span>
                    </span>
                  </button>
                </li>
              )
            })}
          </ul>
          <Button
            size="lg"
            className="h-12 rounded-full"
            disabled={!picked}
            onClick={() => picked && onPick(picked)}
          >
            Start session
          </Button>
        </div>
      </PopupContent>
    </Popup>
  )
}

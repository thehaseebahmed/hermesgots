import { useState } from "react"
import { CheckIcon, FolderGit2Icon, PlusIcon } from "lucide-react"

import { Bot } from "@/components/bot"
import { Popup, PopupContent, PopupHeader, PopupTitle } from "@/components/popup"
import { Button } from "@/components/ui/button"
import type { Profile } from "@/lib/db"
import type { HermesProject } from "@/lib/hermes"
import { cn } from "@/lib/utils"

/** A project a session can be started in, on the first bot of its server. */
export interface SessionTarget {
  key: string
  profile: Profile
  project: HermesProject
  /** Why no session can start in it right now, if none can. */
  blocked?: string
}

/**
 * New session: the one choice is the project, and the bot comes with it, since a project lives on
 * one bot's host. `initial` is the project picked before (the chip in use, else the last one).
 */
export function NewSessionPopup({
  open,
  onOpenChange,
  targets,
  initial,
  onStart,
  onNewProject,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  targets: SessionTarget[]
  initial?: string
  onStart: (target: SessionTarget) => void | Promise<void>
  onNewProject: () => void
}) {
  return (
    <Popup open={open} onOpenChange={onOpenChange}>
      <PopupContent className="max-h-[90dvh]">
        <PopupHeader className="pb-2">
          <PopupTitle>New session</PopupTitle>
        </PopupHeader>
        <SessionForm
          // A fresh pick every time the sheet opens.
          key={open ? (initial ?? "") : "closed"}
          targets={targets}
          initial={initial}
          onStart={onStart}
          onNewProject={onNewProject}
        />
      </PopupContent>
    </Popup>
  )
}

function SessionForm({
  targets,
  initial,
  onStart,
  onNewProject,
}: {
  targets: SessionTarget[]
  initial?: string
  onStart: (target: SessionTarget) => void | Promise<void>
  onNewProject: () => void
}) {
  const startable = targets.filter((t) => !t.blocked)
  const [picked, setPicked] = useState(
    () => startable.find((t) => t.key === initial)?.key ?? startable[0]?.key,
  )
  const [busy, setBusy] = useState(false)
  const target = startable.find((t) => t.key === picked)

  if (!targets.length)
    return (
      <div className="flex flex-col items-center gap-4 px-6 pt-4 pb-8 text-center">
        <p className="text-sm text-muted-foreground">No projects yet.</p>
        <Button size="lg" className="h-12 rounded-full px-5" onClick={onNewProject}>
          <PlusIcon /> New project
        </Button>
      </div>
    )

  return (
    <form
      className="flex min-h-0 flex-col"
      onSubmit={async (event) => {
        event.preventDefault()
        if (!target || busy) return
        setBusy(true)
        try {
          await onStart(target)
        } finally {
          setBusy(false)
        }
      }}
    >
      <div
        role="radiogroup"
        aria-label="Project"
        className="flex min-h-0 flex-col gap-0.5 overflow-y-auto px-4 sm:px-6"
      >
        {targets.map((t) => {
          const selected = t.key === picked
          return (
            <button
              key={t.key}
              type="button"
              role="radio"
              aria-checked={selected}
              disabled={Boolean(t.blocked)}
              onClick={() => setPicked(t.key)}
              className={cn(
                "flex min-h-16 w-full items-center gap-3 rounded-2xl px-3 py-2 text-left outline-none hover:bg-muted/60 focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50 disabled:hover:bg-transparent",
                selected && "bg-muted hover:bg-muted",
              )}
            >
              <span className="relative shrink-0">
                <span className="flex size-10 items-center justify-center rounded-full bg-primary/10 text-primary [&_svg]:size-5">
                  <FolderGit2Icon />
                </span>
                <span className="absolute -right-1 -bottom-1 flex size-5 items-center justify-center overflow-hidden rounded-full bg-background ring-2 ring-background">
                  <Bot id={t.profile.botId} className="size-[85%]" />
                </span>
              </span>
              <span className="flex min-w-0 flex-1 flex-col">
                <span className="truncate font-medium">{t.project.name}</span>
                <span className="truncate text-sm text-muted-foreground">
                  {t.blocked ?? t.profile.name}
                </span>
              </span>
              {selected && <CheckIcon className="size-5 shrink-0" />}
            </button>
          )
        })}
      </div>
      <div className="sticky bottom-0 bg-popover px-4 pt-4 pb-[max(1rem,env(safe-area-inset-bottom))] sm:px-6 md:pb-6">
        <Button
          type="submit"
          size="lg"
          className="h-12 w-full rounded-full text-base"
          disabled={!target || busy}
        >
          Start session
        </Button>
      </div>
    </form>
  )
}

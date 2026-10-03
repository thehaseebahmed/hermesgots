import { useCallback, useState } from "react"
import { useLiveQuery } from "dexie-react-hooks"
import { ChevronRightIcon, FolderIcon, MenuIcon, RefreshCwIcon } from "lucide-react"

import { Bot } from "@/components/bot"
import { CopyBlock } from "@/components/copy-block"
import { useOpenDrawer } from "@/components/drawer-context"
import { Button } from "@/components/ui/button"
import { Card } from "@/components/ui/card"
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible"
import { Spinner } from "@/components/ui/spinner"
import { listProfiles, type Profile } from "@/lib/db"

type Project = { id: string; name: string; path: string }

// TODO(pass B): replace with syncProjects(profile) from lib/projects.ts once the plugin route exists.
const FIXTURE_PROJECTS: Project[] = [
  { id: "memento", name: "Memento", path: "~/code/memento" },
  { id: "hermes-agent", name: "Hermes Agent", path: "~/code/hermes-agent" },
  { id: "dotfiles", name: "dotfiles", path: "~/dotfiles" },
]

/** Hermes Projects, grouped by bot. A read-only picker — no boards, no tasks. */
export function CodePage() {
  const openDrawer = useOpenDrawer()
  const profiles = useLiveQuery(listProfiles, [])
  const [tick, setTick] = useState(0)
  const refresh = useCallback(() => setTick((n) => n + 1), [])

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-y-auto">
      <header className="sticky top-0 z-10 bg-background/80 px-4 pt-[max(0.75rem,env(safe-area-inset-top))] pb-3 backdrop-blur">
        <div className="mx-auto flex max-w-2xl items-center gap-3">
          <Button
            variant="outline"
            size="icon-lg"
            className="size-11 rounded-full md:hidden"
            onClick={openDrawer}
            aria-label="Open conversations"
          >
            <MenuIcon />
          </Button>
          <h1 className="flex-1 text-xl font-semibold tracking-tight">Code</h1>
          <Button
            variant="outline"
            size="icon-lg"
            className="size-11 rounded-full"
            onClick={refresh}
            aria-label="Refresh"
          >
            <RefreshCwIcon />
          </Button>
        </div>
      </header>

      <div className="mx-auto flex w-full max-w-2xl flex-col gap-6 px-4 pb-[max(2rem,env(safe-area-inset-bottom))]">
        {profiles?.map((profile, index) => (
          <BotProjects key={profile.id} profile={profile} demoState={demoStateFor(index)} tick={tick} />
        ))}
      </div>
    </div>
  )
}

type DemoState = "ready" | "loading" | "missing"

// TODO(pass B): drop this — every bot will hit the same syncProjects() call and land wherever it lands.
function demoStateFor(index: number): DemoState {
  if (index === 1) return "loading"
  if (index === 2) return "missing"
  return "ready"
}

const INSTALL_PLUGIN = `hermes plugins install thehaseebahmed/memento/plugin --enable
hermes gateway restart`

function PluginMissing() {
  return (
    <Card className="gap-3 rounded-3xl px-4 py-4">
      <p className="text-sm">
        Code needs the Memento plugin on this Hermes server. Install it from the Hermes CLI:
      </p>
      <CopyBlock label="Copy install commands" text={INSTALL_PLUGIN} />
    </Card>
  )
}

function BotProjects({
  profile,
  demoState,
}: {
  profile: Profile
  demoState: DemoState
  tick: number
}) {
  const projects = demoState === "ready" ? FIXTURE_PROJECTS : undefined

  return (
    <Collapsible defaultOpen>
      <CollapsibleTrigger className="group/bot flex min-h-11 w-full min-w-0 items-center gap-3 rounded-2xl px-1 py-1 text-left outline-none focus-visible:ring-2 focus-visible:ring-ring">
        <ChevronRightIcon className="size-4 shrink-0 text-muted-foreground transition-transform group-data-[panel-open]/bot:rotate-90" />
        <Bot id={profile.botId} className="size-9" />
        <span className="min-w-0 flex-1">
          <span className="block truncate font-semibold">{profile.name}</span>
          {projects && (
            <span className="block text-xs text-muted-foreground">
              {projects.length} {projects.length === 1 ? "project" : "projects"}
            </span>
          )}
        </span>
      </CollapsibleTrigger>
      <CollapsibleContent>
        <div className="flex flex-col gap-3 pt-2">
          {demoState === "missing" ? (
            <PluginMissing />
          ) : !projects ? (
            <p className="flex items-center gap-2 px-1 text-sm text-muted-foreground">
              <Spinner className="size-4" /> Loading projects…
            </p>
          ) : projects.length === 0 ? (
            <p className="px-1 text-sm text-muted-foreground">No projects yet.</p>
          ) : (
            projects.map((project) => <ProjectCard key={project.id} project={project} />)
          )}
        </div>
      </CollapsibleContent>
    </Collapsible>
  )
}

function ProjectCard({ project }: { project: Project }) {
  return (
    <Card className="flex-row items-center gap-3 rounded-3xl px-4 py-3" aria-label={project.name}>
      <FolderIcon className="size-5 shrink-0 text-muted-foreground" />
      <div className="min-w-0 flex-1">
        <h3 className="truncate font-medium">{project.name}</h3>
        <p className="truncate text-xs text-muted-foreground">{project.path}</p>
      </div>
    </Card>
  )
}

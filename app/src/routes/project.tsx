import { useEffect, useState } from "react"
import { useLiveQuery } from "dexie-react-hooks"
import { ArrowLeftIcon, PlusIcon } from "lucide-react"
import { Link, useLocation, useParams, useSearchParams } from "react-router"

import { ChatHeader } from "@/components/chat/chat-header"
import { CheckpointList } from "@/components/checkpoints"
import { Button } from "@/components/ui/button"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { db } from "@/lib/db"
import { listProjects, type HermesProject } from "@/lib/hermes"

const TABS = ["sessions", "library", "prs", "checkpoints"]

/** One Hermes Project: its sessions, library, PRs and checkpoints. */
export function ProjectPage() {
  const { profileId = "", projectId = "" } = useParams()
  // In the URL, so coming back from a checkpoint's diff lands on its tab.
  const [search, setSearch] = useSearchParams()
  const tab = TABS.includes(search.get("tab") ?? "") ? search.get("tab")! : "sessions"
  const passed = (useLocation().state as { project?: HermesProject } | null)?.project
  const profile = useLiveQuery(() => db.profiles.get(profileId), [profileId])
  const [fetched, setFetched] = useState<HermesProject>()
  const project = passed?.id === projectId ? passed : fetched

  // Opened from a link or a reload, with no project handed over by the Code screen.
  useEffect(() => {
    if (!profile || passed?.id === projectId) return
    let cancelled = false
    listProjects(profile)
      .then((all) => !cancelled && setFetched(all.find((p) => p.id === projectId)))
      .catch(() => {})
    return () => {
      cancelled = true
    }
  }, [profile, passed, projectId])

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <ChatHeader
        className="relative pb-2"
        title={project?.name ?? ""}
        subtitle={profile?.name}
        showBot={false}
        leading={
          <Button
            variant="outline"
            size="icon-lg"
            className="size-11 rounded-full"
            render={<Link to="/code" />}
            nativeButton={false}
            aria-label="Back"
          >
            <ArrowLeftIcon />
          </Button>
        }
      />
      <Tabs
        value={tab}
        onValueChange={(value) =>
          setSearch(value === "sessions" ? {} : { tab: String(value) }, {
            replace: true,
            state: { project },
          })
        }
        className="flex-1"
      >
        <div className="px-4">
          <TabsList className="mx-auto max-w-2xl">
            <TabsTrigger value="sessions">Sessions</TabsTrigger>
            <TabsTrigger value="library">Library</TabsTrigger>
            <TabsTrigger value="prs">PRs</TabsTrigger>
            <TabsTrigger value="checkpoints">Checkpoints</TabsTrigger>
          </TabsList>
        </div>
        <TabsContent value="sessions" className="flex flex-col overflow-y-auto">
          <div className="mx-auto w-full max-w-2xl flex-1 px-4 py-6">
            <p className="px-1 text-sm text-muted-foreground">No sessions yet.</p>
          </div>
          <div className="sticky bottom-0 px-4 pb-[max(1rem,env(safe-area-inset-bottom))]">
            <div className="mx-auto flex w-full max-w-2xl justify-end">
              <Button size="lg" className="h-12 rounded-full px-5 shadow-lg">
                <PlusIcon /> New session
              </Button>
            </div>
          </div>
        </TabsContent>
        <TabsContent value="library" />
        <TabsContent value="prs" />
        <TabsContent value="checkpoints" className="overflow-y-auto">
          <div className="mx-auto w-full max-w-2xl px-4 py-6 pb-[max(1.5rem,env(safe-area-inset-bottom))]">
            {profile && project && <CheckpointList profile={profile} project={project} />}
          </div>
        </TabsContent>
      </Tabs>
    </div>
  )
}

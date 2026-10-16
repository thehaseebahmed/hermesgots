import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react"
import { useLiveQuery } from "dexie-react-hooks"
import {
  ArchiveIcon,
  ArchiveRestoreIcon,
  ArrowLeftIcon,
  ChevronUpIcon,
  EllipsisIcon,
  PencilIcon,
  PinIcon,
  PinOffIcon,
  Trash2Icon,
} from "lucide-react"
import { useLocation, useParams } from "react-router"
import { toast } from "sonner"

import { HOST_WORK_MS, SAFETY_MS } from "@/lib/freshness"
import { quietly } from "@/lib/report"
import { ChatHeader } from "@/components/chat/chat-header"
import { PR_GROUPS } from "@/components/chat/pr-look"
import { PrRow } from "@/components/chat/pr-pill"
import { LibraryTab } from "@/components/library"
import { ProjectSettings } from "@/components/project-settings"
import { ProjectUsageView } from "@/components/project-usage"
import { RepoChips } from "@/components/repos"
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog"
import { Button } from "@/components/ui/button"
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { stopMessage } from "@/lib/chat"
import { projectKey, useProjectSessions, useSessionFollowUps } from "@/lib/code"
import {
  byNewestPr,
  db,
  deleteConversation,
  prKey,
  type Conversation,
  type PullRequestRef,
} from "@/lib/db"
import { useChanges, useLive } from "@/lib/live"
import { setBackGuard } from "@/lib/native"
import { useNav } from "@/lib/nav"
import { useProjectsPane, useRememberOpened } from "@/lib/pane"
import { usePoll } from "@/lib/poll"
import { deleteProject, updateProject, type HermesProject } from "@/lib/hermes"
import { readProjects, useProjects } from "@/lib/projects"
import { projectRepos } from "@/lib/workspace"

/**
 * One Hermes Project: its goal and repos, then its library, pull requests and usage. Its sessions
 * are listed in Code. Beside the list of projects (see `useProjectsPane`) it is the item pane.
 */
export function ProjectPage() {
  const { profileId = "", projectId = "" } = useParams()
  const beside = Boolean(useProjectsPane())
  const { up } = useNav()
  const back = useCallback(() => up("/projects"), [up])
  // Beside the list a project is the top-level screen, so back leaves the app.
  useEffect(() => (beside ? undefined : setBackGuard(() => (back(), true))), [back, beside])
  const passed = (useLocation().state as { project?: HermesProject } | null)?.project
  const profile = useLiveQuery(() => db.profiles.get(profileId), [profileId])
  const baseUrl = profile?.baseUrl
  const apiKey = profile?.apiKey
  const server = useMemo(
    () => (baseUrl !== undefined && apiKey !== undefined ? { baseUrl, apiKey } : undefined),
    [baseUrl, apiKey],
  )
  const fetched = useProjects(server)?.find((p) => p.id === projectId)
  // The list hands the project over, so it shows at once; it's read again here regardless.
  const project = fetched ?? (passed?.id === projectId ? passed : undefined)
  useRememberOpened("projects", project ? `${profileId}/${projectId}` : undefined)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [deleting, setDeleting] = useState(false)
  const [busy, setBusy] = useState(false)
  const [tab, setTab] = useState("library")
  const [reads, setReads] = useState(0)
  const reload = () => setReads((n) => n + 1)
  const streaming = useLive(profile)
  const projectChanges = useChanges("projects", profile)
  const changing = project?.folders.some((f) => f.status === "cloning" || f.status === "removing")

  useEffect(() => {
    if (!server) return
    readProjects(server).catch(quietly("Reading projects"))
  }, [server, reads, projectChanges])

  usePoll(() => setReads((n) => n + 1), streaming ? SAFETY_MS : HOST_WORK_MS, [], {
    active: Boolean(changing),
    immediate: false,
    onShow: false,
  })

  const listed = useProjectSessions(server ? projectKey(server, projectId) : undefined)
  const sessions = server ? listed?.sessions : undefined
  useSessionFollowUps(sessions)
  // Each session's title by its worktree's name, so a library file can say which filed it.
  const titles = useMemo(
    () =>
      new Map(
        (sessions ?? [])
          .filter((c) => c.worktree?.branch)
          .map((c) => [c.worktree!.branch.replace(/^hermes\//, ""), c.title]),
      ),
    [sessions],
  )
  const prs = projectPrs(sessions ?? [])
  const repos = project ? projectRepos(project) : []
  const subtitle = [
    profile?.name,
    repos.length > 1 ? `${repos.length} repositories` : repos[0]?.name,
  ]
    .filter(Boolean)
    .join(" · ")

  const act = async (action: () => Promise<void>, fallback: string) => {
    try {
      await action()
      reload()
    } catch (error) {
      toast.error(error instanceof Error ? error.message : fallback)
    }
  }

  const remove = async () => {
    if (!profile) return
    setBusy(true)
    try {
      await deleteProject(profile, projectId)
      for (const c of sessions ?? []) {
        stopMessage(c.id)
        await deleteConversation(c.id)
      }
      setDeleting(false)
      back()
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Couldn't delete the project.")
    } finally {
      setBusy(false)
    }
  }

  const ready = profile && project?.status === "ready"

  return (
    <div className="mx-auto flex min-h-0 w-full max-w-2xl flex-1 flex-col">
      <ChatHeader
        className="relative pb-2"
        title={project?.name ?? ""}
        subtitle={subtitle}
        showBot={false}
        leading={
          beside ? null : (
            <Button
              variant="outline"
              size="icon-lg"
              className="size-11 rounded-full"
              onClick={back}
              aria-label="Back to Projects"
            >
              <ArrowLeftIcon />
            </Button>
          )
        }
        actions={
          ready && (
            <DropdownMenu>
              <DropdownMenuTrigger
                render={
                  <Button
                    variant="outline"
                    size="icon-lg"
                    className="size-11 rounded-full bg-background/80 backdrop-blur"
                    aria-label="Project options"
                  />
                }
              >
                <EllipsisIcon />
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="min-w-48">
                <DropdownMenuItem className="min-h-11" onClick={() => setSettingsOpen(true)}>
                  <PencilIcon />
                  Edit
                </DropdownMenuItem>
                <DropdownMenuItem
                  className="min-h-11"
                  onClick={() =>
                    void act(
                      () => updateProject(profile, projectId, { pinned: !project.pinnedAt }),
                      "Couldn't pin the project.",
                    )
                  }
                >
                  {project.pinnedAt ? <PinOffIcon /> : <PinIcon />}
                  {project.pinnedAt ? "Unpin" : "Pin"}
                </DropdownMenuItem>
                <DropdownMenuItem
                  className="min-h-11"
                  onClick={() =>
                    void act(
                      () => updateProject(profile, projectId, { archived: !project.archived }),
                      "Couldn't archive the project.",
                    )
                  }
                >
                  {project.archived ? <ArchiveRestoreIcon /> : <ArchiveIcon />}
                  {project.archived ? "Unarchive" : "Archive"}
                </DropdownMenuItem>
                <DropdownMenuSeparator />
                <DropdownMenuItem
                  variant="destructive"
                  className="min-h-11"
                  onClick={() => setDeleting(true)}
                >
                  <Trash2Icon />
                  Delete
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          )
        }
      />
      {project && (project.description || repos.length > 0 || project.archived) && (
        <div className="flex flex-col gap-3 px-4 pb-4">
          {project.archived && (
            <p className="flex items-center justify-center gap-2 text-sm text-muted-foreground">
              <ArchiveIcon className="size-4" /> Archived
            </p>
          )}
          {project.description && (
            <p className="text-center text-sm text-muted-foreground">{project.description}</p>
          )}
          <RepoChips repos={repos} />
        </div>
      )}
      <Tabs value={tab} onValueChange={setTab} className="flex-1">
        <TabsList>
          <TabsTrigger value="library">Library</TabsTrigger>
          <TabsTrigger value="prs">Pull requests</TabsTrigger>
          <TabsTrigger value="usage">Usage</TabsTrigger>
        </TabsList>
        <TabsContent value="library" className="flex-1 overflow-y-auto">
          {server && (
            <div className="mx-auto w-full max-w-2xl">
              <LibraryTab
                config={server}
                projectId={projectId}
                titles={titles}
                active={tab === "library"}
              />
            </div>
          )}
        </TabsContent>
        <TabsContent value="prs" className="overflow-y-auto">
          <div className="mx-auto w-full max-w-2xl px-4 py-6">
            {sessions && prs.length === 0 ? (
              <p className="px-1 text-sm text-muted-foreground">No pull requests yet.</p>
            ) : (
              <div className="flex flex-col gap-6">
                {PR_GROUPS.map((group) => {
                  const list = prs.filter((pr) => group.states.includes(pr.state))
                  if (!list.length) return null
                  return (
                    <Group
                      key={group.label}
                      label={group.label}
                      count={list.length}
                      fold={group.fold}
                    >
                      {list.map((pr) => (
                        <li key={prKey(pr)}>
                          <PrRow pr={pr} />
                        </li>
                      ))}
                    </Group>
                  )
                })}
              </div>
            )}
          </div>
        </TabsContent>
        <TabsContent value="usage" className="overflow-y-auto pt-4">
          {server && project && tab === "usage" && (
            <ProjectUsageView config={server} project={project} />
          )}
        </TabsContent>
      </Tabs>

      {ready && (
        <ProjectSettings
          open={settingsOpen}
          onOpenChange={setSettingsOpen}
          profile={profile}
          project={project}
          onChanged={reload}
        />
      )}

      <AlertDialog open={deleting} onOpenChange={setDeleting}>
        <AlertDialogContent size="sm">
          <AlertDialogHeader>
            <AlertDialogTitle>Delete this project?</AlertDialogTitle>
            <AlertDialogDescription>
              The project and its sessions are removed from this device. Its folders on the server
              stay where they are, and Hermes keeps its own copy of the sessions.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction variant="destructive" disabled={busy} onClick={() => void remove()}>
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}

/** A finished group longer than this starts folded. */
const FOLD_OVER = 5

/**
 * A titled list that folds away; a finished one (`fold`) longer than `FOLD_OVER` starts folded.
 * It's mounted once its first item is known, so that count decides.
 */
function Group({
  label,
  count,
  fold,
  children,
}: {
  label: string
  count: number
  fold?: boolean
  children: ReactNode
}) {
  return (
    <Collapsible defaultOpen={!fold || count <= FOLD_OVER} render={<section aria-label={label} />}>
      <h2>
        <CollapsibleTrigger className="group -mx-1 flex min-h-11 items-center gap-1.5 rounded-xl px-2 text-sm text-muted-foreground outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring">
          {label} ({count})
          <ChevronUpIcon className="size-4 rotate-180 transition-transform group-data-panel-open:rotate-0 motion-reduce:transition-none" />
        </CollapsibleTrigger>
      </h2>
      <CollapsibleContent>
        <ul>{children}</ul>
      </CollapsibleContent>
    </Collapsible>
  )
}

/** Every session's pull requests, each once, newest number first. */
function projectPrs(sessions: Conversation[]) {
  const byKey = new Map<string, PullRequestRef>()
  for (const pr of sessions.flatMap((c) => c.prs ?? [])) {
    const key = prKey(pr)
    const known = byKey.get(key)
    if (!known || pr.at > known.at) byKey.set(key, pr)
  }
  return [...byKey.values()].sort(byNewestPr)
}

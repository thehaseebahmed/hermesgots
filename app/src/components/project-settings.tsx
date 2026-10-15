import { useEffect, useState, type ReactNode } from "react"
import {
  ArchiveIcon,
  ArchiveRestoreIcon,
  ArrowLeftIcon,
  ChartLineIcon,
  CodeXmlIcon,
  GitForkIcon,
  LockIcon,
  PinIcon,
  PinOffIcon,
  PlusIcon,
  RotateCcwIcon,
  SearchIcon,
  Trash2Icon,
  XIcon,
  type LucideIcon,
} from "lucide-react"
import { toast } from "sonner"

import { Popup, PopupContent, PopupHeader, PopupTitle } from "@/components/popup"
import { ProjectUsageView } from "@/components/project-usage"
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
import { Spinner } from "@/components/ui/spinner"
import type { Profile } from "@/lib/db"
import {
  addProjectRepo,
  getGitHubStatus,
  listGitHubRepos,
  removeProjectRepo,
  updateProject,
  type GitHubRepo,
  type GitHubStatus,
  type HermesProject,
  type HermesProjectFolder,
} from "@/lib/hermes"
import { cn } from "@/lib/utils"

const REPO_RE = /^[\w-]+\/[\w.-]+$/
const SUGGESTIONS = 2

const ROW = "flex min-h-14 w-full items-center gap-4 bg-muted px-5 py-3 text-left"
const ROW_BUTTON = cn(ROW, "transition-colors outline-none hover:bg-accent focus-visible:bg-accent")

const names = new Intl.ListFormat(undefined, { type: "conjunction" })

/** The repos the sheet lists: a project's GitHub repos, with any being added or removed. */
function projectRepos(project: HermesProject) {
  return project.folders.filter(
    (folder): folder is HermesProjectFolder & { repo: string } =>
      Boolean(folder.repo) && (folder.git || Boolean(folder.status)),
  )
}

/**
 * A project's settings: its name, goal and repos (saved together), its usage, and pinning,
 * archiving and deleting it (at once). Adding and removing repos runs on the plugin, in the
 * background.
 */
export function ProjectSettings({
  open,
  onOpenChange,
  profile,
  project,
  onChanged,
  onArchived,
  onDelete,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  profile: Profile
  project: HermesProject
  /** Something changed on the plugin; read the project again. */
  onChanged: () => void
  onArchived: () => void
  onDelete: () => void
}) {
  const [view, setView] = useState<"settings" | "usage">("settings")
  return (
    <Popup
      open={open}
      onOpenChange={(next) => {
        if (next) setView("settings")
        onOpenChange(next)
      }}
      onOpenChangeComplete={(next) => !next && setView("settings")}
    >
      <PopupContent className="max-h-[92dvh] pb-0 md:max-h-[85dvh] md:pb-0">
        {/* Centred, so the room the back button takes on the left mirrors the close button's on
            the right: without it the heading sits left of the panel's axis. */}
        <PopupHeader className={cn("relative pb-2", view === "usage" && "md:pl-16")}>
          {view === "usage" && (
            <Button
              variant="ghost"
              size="icon-sm"
              className="absolute top-4 left-4"
              onClick={() => setView("settings")}
              aria-label="Back"
            >
              <ArrowLeftIcon />
            </Button>
          )}
          <PopupTitle>{view === "usage" ? "Usage" : "Settings"}</PopupTitle>
        </PopupHeader>
        {view === "usage" ? (
          <ProjectUsageView profile={profile} project={project} />
        ) : (
          <SettingsForm
            // Fresh fields every time the sheet opens on the project as it now is.
            key={open ? project.id : "closed"}
            profile={profile}
            project={project}
            onClose={() => onOpenChange(false)}
            onChanged={onChanged}
            onArchived={onArchived}
            onDelete={onDelete}
            onUsage={() => setView("usage")}
          />
        )}
      </PopupContent>
    </Popup>
  )
}

function SettingsForm({
  profile,
  project,
  onClose,
  onChanged,
  onArchived,
  onDelete,
  onUsage,
}: {
  profile: Profile
  project: HermesProject
  onClose: () => void
  onChanged: () => void
  onArchived: () => void
  onDelete: () => void
  onUsage: () => void
}) {
  const [name, setName] = useState(project.name)
  const [goal, setGoal] = useState(project.description ?? "")
  const [added, setAdded] = useState<string[]>([])
  const [removed, setRemoved] = useState<string[]>([])
  const [picking, setPicking] = useState(false)
  const [busy, setBusy] = useState(false)
  const [confirming, setConfirming] = useState(false)
  const [github, setGitHub] = useState<GitHubStatus>()
  const [ghRepos, setGhRepos] = useState<GitHubRepo[]>()

  useEffect(() => {
    let cancelled = false
    getGitHubStatus(profile)
      .then(async (status) => {
        if (cancelled) return
        setGitHub(status)
        if (!status.connected) return
        const list = await listGitHubRepos(profile)
        if (!cancelled) setGhRepos(list)
      })
      .catch(() => !cancelled && setGitHub({ connected: false }))
    return () => {
      cancelled = true
    }
  }, [profile])

  const repos = projectRepos(project)
  const listed = new Set([...repos.map((folder) => folder.repo), ...added])
  const shown = repos.filter((folder) => !removed.includes(folder.repo))
  const suggestions = (ghRepos ?? [])
    .filter((repo) => !listed.has(repo.fullName))
    .slice(0, SUGGESTIONS)
  // Removing a cloned repo deletes it on the server; one still being added is just stopped.
  const dropping = repos
    .filter((folder) => removed.includes(folder.repo) && !folder.status)
    .map((folder) => folder.repo)

  const dirty =
    name.trim() !== project.name ||
    goal.trim() !== (project.description ?? "") ||
    added.length > 0 ||
    removed.length > 0

  const stage = (repo: string) => {
    if (listed.has(repo)) return
    setAdded((current) => [...current, repo])
  }

  const save = async () => {
    if (!name.trim() || busy) return
    setBusy(true)
    try {
      if (name.trim() !== project.name || goal.trim() !== (project.description ?? ""))
        await updateProject(profile, project.id, { name: name.trim(), description: goal.trim() })
      for (const repo of removed) await removeProjectRepo(profile, project.id, repo)
      for (const repo of added) await addProjectRepo(profile, project.id, repo)
      onChanged()
      onClose()
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Couldn't save the project.")
      onChanged()
    } finally {
      setBusy(false)
    }
  }

  const act = async (action: () => Promise<void>, fallback: string) => {
    setBusy(true)
    try {
      await action()
      onChanged()
    } catch (error) {
      toast.error(error instanceof Error ? error.message : fallback)
    } finally {
      setBusy(false)
    }
  }

  return (
    <form
      className="flex flex-col"
      onSubmit={(event) => {
        event.preventDefault()
        if (dropping.length) setConfirming(true)
        else void save()
      }}
    >
      <fieldset className="flex min-w-0 flex-col gap-6 px-4 pb-4 sm:px-6" disabled={busy}>
        <Section label="Name" htmlFor="project-name">
          <div className="flex items-center gap-3 rounded-3xl bg-muted p-2">
            <span className="flex size-12 shrink-0 items-center justify-center rounded-2xl bg-background/60">
              <CodeXmlIcon className="size-5 text-muted-foreground" />
            </span>
            <input
              id="project-name"
              className="h-11 min-w-0 flex-1 bg-transparent pr-3 text-base outline-none"
              autoComplete="off"
              value={name}
              onChange={(event) => setName(event.target.value)}
            />
          </div>
        </Section>

        <Section label="Goal" htmlFor="project-goal">
          <textarea
            id="project-goal"
            rows={3}
            placeholder="What this project is for"
            className="w-full resize-none rounded-3xl bg-muted px-5 py-4 text-base outline-none placeholder:text-muted-foreground focus-visible:ring-2 focus-visible:ring-ring"
            value={goal}
            onChange={(event) => setGoal(event.target.value)}
          />
        </Section>

        <Section
          label={
            <>
              Context <span className="text-muted-foreground">(optional)</span>
            </>
          }
        >
          <Group>
            {shown.map((folder) => (
              <RepoRow
                key={folder.repo}
                folder={folder}
                onRemove={() => setRemoved((current) => [...current, folder.repo])}
                onRetry={() =>
                  void act(
                    () => addProjectRepo(profile, project.id, folder.repo),
                    `Couldn't add ${folder.repo}.`,
                  )
                }
              />
            ))}
            {added.map((repo) => (
              <RepoRow
                key={repo}
                folder={{ repo }}
                onRemove={() => setAdded((current) => current.filter((r) => r !== repo))}
              />
            ))}
            <button type="button" className={ROW_BUTTON} onClick={() => setPicking((on) => !on)}>
              <PlusIcon className="size-5 shrink-0" />
              <span className="flex-1 text-base">Add context</span>
            </button>
          </Group>
          {picking && (
            <RepoPicker
              github={github}
              repos={ghRepos}
              listed={listed}
              onPick={(repo) => {
                stage(repo)
                setPicking(false)
              }}
            />
          )}
          {!picking &&
            suggestions.map((repo) => (
              <button
                key={repo.fullName}
                type="button"
                onClick={() => stage(repo.fullName)}
                className="flex min-h-14 w-full items-center gap-4 rounded-3xl border border-dashed px-5 py-3 text-left text-muted-foreground outline-none hover:bg-muted/60 focus-visible:ring-2 focus-visible:ring-ring"
                aria-label={`Add ${repo.fullName}`}
              >
                <GitForkIcon className="size-5 shrink-0" />
                <span className="min-w-0 flex-1 truncate text-base">{repo.fullName}</span>
                <PlusIcon className="size-5 shrink-0" />
              </button>
            ))}
        </Section>

        <Group>
          <ActionRow icon={ChartLineIcon} onClick={onUsage}>
            Usage
          </ActionRow>
          <ActionRow
            icon={project.pinnedAt ? PinOffIcon : PinIcon}
            onClick={() =>
              void act(
                () => updateProject(profile, project.id, { pinned: !project.pinnedAt }),
                "Couldn't pin the project.",
              )
            }
          >
            {project.pinnedAt ? "Unpin" : "Pin"}
          </ActionRow>
          <ActionRow
            icon={project.archived ? ArchiveRestoreIcon : ArchiveIcon}
            onClick={() =>
              void act(async () => {
                await updateProject(profile, project.id, { archived: !project.archived })
                if (!project.archived) {
                  onClose()
                  onArchived()
                }
              }, "Couldn't archive the project.")
            }
          >
            {project.archived ? "Unarchive" : "Archive"}
          </ActionRow>
          <ActionRow
            icon={Trash2Icon}
            destructive
            onClick={() => {
              onClose()
              onDelete()
            }}
          >
            Delete
          </ActionRow>
        </Group>
      </fieldset>

      <div className="sticky bottom-0 bg-popover px-4 pt-2 pb-[max(1rem,env(safe-area-inset-bottom))] sm:px-6 md:pb-6">
        <Button
          type="submit"
          size="lg"
          className="h-12 w-full rounded-full text-base"
          disabled={busy || !dirty || !name.trim()}
        >
          {busy ? <Spinner /> : "Save"}
        </Button>
      </div>

      <AlertDialog open={confirming} onOpenChange={setConfirming}>
        <AlertDialogContent size="sm">
          <AlertDialogHeader>
            <AlertDialogTitle>
              Remove {dropping.length === 1 ? dropping[0] : `${dropping.length} repos`}?
            </AlertDialogTitle>
            <AlertDialogDescription>
              The server deletes its copy of {names.format(dropping)}, with any work in it that
              isn't pushed. Sessions that used it can still be read, but not continued.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              onClick={() => {
                setConfirming(false)
                void save()
              }}
            >
              Remove
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </form>
  )
}

function Section({
  label,
  htmlFor,
  children,
}: {
  label: ReactNode
  htmlFor?: string
  children: ReactNode
}) {
  const Label = htmlFor ? "label" : "h3"
  return (
    <section className="flex flex-col gap-2">
      <Label htmlFor={htmlFor} className="px-1 text-sm font-medium">
        {label}
      </Label>
      {children}
    </section>
  )
}

function Group({ children }: { children: ReactNode }) {
  return <div className="flex flex-col gap-0.5 overflow-hidden rounded-3xl">{children}</div>
}

function ActionRow({
  icon: Icon,
  destructive,
  onClick,
  children,
}: {
  icon: LucideIcon
  destructive?: boolean
  onClick: () => void
  children: ReactNode
}) {
  return (
    <button
      type="button"
      className={cn(ROW_BUTTON, destructive && "text-destructive")}
      onClick={onClick}
    >
      <Icon className="size-5 shrink-0" />
      <span className="flex-1 text-base">{children}</span>
    </button>
  )
}

/** A repo of the project; while it's being added or removed, how that's going. */
function RepoRow({
  folder,
  onRemove,
  onRetry,
}: {
  folder: Pick<HermesProjectFolder, "status" | "error"> & { repo: string }
  onRemove: () => void
  onRetry?: () => void
}) {
  const { repo, status } = folder
  const note =
    status === "cloning"
      ? "Adding…"
      : status === "removing"
        ? "Removing…"
        : status === "failed"
          ? (folder.error ?? "Couldn't clone.")
          : undefined
  return (
    <div className={cn(ROW, "py-2 pr-2")}>
      <GitForkIcon className="size-5 shrink-0" />
      <span className="flex min-w-0 flex-1 flex-col">
        <span
          className={cn("truncate text-base", status === "removing" && "text-muted-foreground")}
        >
          {repo}
        </span>
        {note && (
          <span
            className={cn(
              "flex items-center gap-1.5 truncate text-sm",
              status === "failed" ? "text-destructive" : "text-muted-foreground",
            )}
          >
            {(status === "cloning" || status === "removing") && <Spinner className="size-3.5" />}
            {note}
          </span>
        )}
      </span>
      {status === "failed" && onRetry && (
        <Button
          type="button"
          variant="ghost"
          size="icon-lg"
          className="size-11 shrink-0 rounded-full"
          onClick={onRetry}
          aria-label={`Retry ${repo}`}
        >
          <RotateCcwIcon />
        </Button>
      )}
      {status !== "removing" && (
        <Button
          type="button"
          variant="ghost"
          size="icon-lg"
          className="size-11 shrink-0 rounded-full"
          onClick={onRemove}
          aria-label={`Remove ${repo}`}
        >
          <XIcon />
        </Button>
      )}
    </div>
  )
}

/** The host account's repos to pick from, or an `owner/name` field when it has no GitHub account. */
function RepoPicker({
  github,
  repos,
  listed,
  onPick,
}: {
  github?: GitHubStatus
  repos?: GitHubRepo[]
  listed: Set<string>
  onPick: (repo: string) => void
}) {
  const [query, setQuery] = useState("")
  const typed = query.trim()
  if (!github)
    return (
      <p className="flex items-center gap-2 px-1 text-sm text-muted-foreground">
        <Spinner className="size-4" /> Checking GitHub…
      </p>
    )
  if (!github.connected) {
    const valid = REPO_RE.test(typed) && !listed.has(typed)
    return (
      <div className="flex gap-2">
        <input
          className="h-12 min-w-0 flex-1 rounded-3xl bg-muted px-5 text-base outline-none focus-visible:ring-2 focus-visible:ring-ring"
          placeholder="owner/name"
          autoComplete="off"
          autoCapitalize="none"
          spellCheck={false}
          autoFocus
          aria-label="Repository"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          onKeyDown={(event) => {
            if (event.key !== "Enter") return
            event.preventDefault()
            if (valid) onPick(typed)
          }}
        />
        <Button
          type="button"
          variant="outline"
          size="icon-lg"
          className="size-12 rounded-full"
          disabled={!valid}
          onClick={() => onPick(typed)}
          aria-label="Add repository"
        >
          <PlusIcon />
        </Button>
      </div>
    )
  }
  const needle = typed.toLowerCase()
  const matches = (repos ?? []).filter(
    (repo) =>
      !listed.has(repo.fullName) && (!needle || repo.fullName.toLowerCase().includes(needle)),
  )
  return (
    <div className="flex flex-col gap-2">
      <div className="flex h-12 items-center gap-3 rounded-3xl bg-muted px-5">
        <SearchIcon className="size-4 shrink-0 text-muted-foreground" />
        <input
          className="h-full min-w-0 flex-1 bg-transparent text-base outline-none"
          placeholder={github.login ? `Search ${github.login}'s repositories` : "Search"}
          autoComplete="off"
          autoFocus
          aria-label="Search repositories"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
        />
      </div>
      <ul className="flex max-h-60 flex-col overflow-y-auto rounded-3xl border p-1">
        {!repos ? (
          <li className="flex items-center gap-2 px-4 py-3 text-sm text-muted-foreground">
            <Spinner className="size-4" /> Loading repositories…
          </li>
        ) : matches.length === 0 ? (
          <li className="px-4 py-3 text-sm text-muted-foreground">No matches.</li>
        ) : (
          matches.map((repo) => (
            <li key={repo.fullName}>
              <button
                type="button"
                onClick={() => onPick(repo.fullName)}
                className="flex min-h-11 w-full items-center gap-3 rounded-2xl px-4 py-2 text-left outline-none hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring"
              >
                <span className="flex min-w-0 flex-1 flex-col">
                  <span className="flex items-center gap-1.5 font-medium">
                    <span className="min-w-0 truncate">{repo.fullName}</span>
                    {repo.private && <LockIcon className="size-3 shrink-0 text-muted-foreground" />}
                  </span>
                  {repo.description && (
                    <span className="truncate text-xs text-muted-foreground">
                      {repo.description}
                    </span>
                  )}
                </span>
                <PlusIcon className="size-4 shrink-0 text-muted-foreground" />
              </button>
            </li>
          ))
        )}
      </ul>
    </div>
  )
}

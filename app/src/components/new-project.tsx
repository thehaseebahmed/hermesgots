import { useEffect, useState } from "react"
import { CheckIcon, CircleAlertIcon, LockIcon, PlusIcon, SearchIcon, XIcon } from "lucide-react"

import { Bot } from "@/components/bot"
import { CopyBlock } from "@/components/copy-block"
import { Popup, PopupContent, PopupHeader, PopupTitle } from "@/components/popup"
import { Button } from "@/components/ui/button"
import { Field, FieldLabel } from "@/components/ui/field"
import { Input } from "@/components/ui/input"
import { InputGroup, InputGroupAddon, InputGroupInput } from "@/components/ui/input-group"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { Spinner } from "@/components/ui/spinner"
import { Textarea } from "@/components/ui/textarea"
import type { Profile } from "@/lib/db"
import {
  createProject,
  getGitHubStatus,
  listGitHubRepos,
  type GitHubRepo,
  type GitHubStatus,
} from "@/lib/hermes"
import { cn } from "@/lib/utils"

const REPO_RE = /^[\w-]+\/[\w.-]+$/
const CONNECT_GITHUB = "gh auth login"

/** Creates a Hermes Project on a bot's server, with the chosen GitHub repos cloned into it. */
export function NewProjectPopup({
  open,
  onOpenChange,
  profiles,
  onCreated,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  /** Bots whose server has the Memento plugin. */
  profiles: Profile[]
  onCreated: (profile: Profile, name: string) => void
}) {
  const [profileId, setProfileId] = useState<string>()
  const profile = profiles.find((p) => p.id === profileId) ?? profiles[0]

  return (
    <Popup open={open} onOpenChange={onOpenChange}>
      <PopupContent className="max-h-[90dvh]">
        <PopupHeader className="items-center pb-2">
          <PopupTitle>New project</PopupTitle>
        </PopupHeader>
        {profile && (
          <ProjectForm
            // A fresh form per bot: its GitHub account and repos are its own.
            key={profile.id}
            profile={profile}
            profiles={profiles}
            onPickBot={setProfileId}
            onCreated={(name) => {
              onCreated(profile, name)
              onOpenChange(false)
            }}
          />
        )}
      </PopupContent>
    </Popup>
  )
}

function ProjectForm({
  profile,
  profiles,
  onPickBot,
  onCreated,
}: {
  profile: Profile
  profiles: Profile[]
  onPickBot: (profileId: string) => void
  onCreated: (name: string) => void
}) {
  const [github, setGitHub] = useState<GitHubStatus>()
  const [repos, setRepos] = useState<GitHubRepo[]>()
  const [name, setName] = useState("")
  const [description, setDescription] = useState("")
  const [picked, setPicked] = useState<string[]>([])
  const [query, setQuery] = useState("")
  const [creating, setCreating] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    getGitHubStatus(profile)
      .then(async (status) => {
        if (cancelled) return
        setGitHub(status)
        if (!status.connected) return
        const list = await listGitHubRepos(profile)
        if (!cancelled) setRepos(list)
      })
      .catch((reason) => {
        if (cancelled) return
        setGitHub({ connected: false, error: reason instanceof Error ? reason.message : undefined })
      })
    return () => {
      cancelled = true
    }
  }, [profile])

  const toggle = (repo: string) => {
    setError(null)
    setPicked((current) =>
      current.includes(repo) ? current.filter((r) => r !== repo) : [...current, repo],
    )
  }

  const typed = query.trim()
  const canAdd = !github?.connected && REPO_RE.test(typed) && !picked.includes(typed)
  const add = () => {
    if (!canAdd) return
    setPicked((current) => [...current, typed])
    setQuery("")
  }

  const valid = name.trim() !== ""

  const submit = async () => {
    if (!valid || creating) return
    setCreating(true)
    setError(null)
    try {
      await createProject(profile, {
        name: name.trim(),
        description: description.trim() || undefined,
        repos: picked,
      })
      onCreated(name.trim())
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Couldn't create the project.")
      setCreating(false)
    }
  }

  const needle = typed.toLowerCase()
  const shown = (repos ?? []).filter((r) => !needle || r.fullName.toLowerCase().includes(needle))

  return (
    <form
      className="px-6"
      onSubmit={(event) => {
        event.preventDefault()
        void submit()
      }}
    >
      <fieldset className="flex min-w-0 flex-col gap-5" disabled={creating}>
        {profiles.length > 1 && (
          <Field>
            <FieldLabel htmlFor="project-bot">Bot</FieldLabel>
            <Select
              value={profile.id}
              items={profiles.map((p) => ({ value: p.id, label: p.name }))}
              onValueChange={(value) => value && onPickBot(value)}
            >
              <SelectTrigger id="project-bot" className="h-11 w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {profiles.map((p) => (
                  <SelectItem key={p.id} value={p.id}>
                    <Bot id={p.botId} className="size-5" />
                    {p.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Field>
        )}

        <Field>
          <FieldLabel htmlFor="project-name">Name</FieldLabel>
          <Input
            id="project-name"
            className="h-11"
            autoComplete="off"
            value={name}
            onChange={(event) => setName(event.target.value)}
          />
        </Field>

        <Field>
          <FieldLabel htmlFor="project-description">Description</FieldLabel>
          <Textarea
            id="project-description"
            placeholder="Optional"
            rows={2}
            value={description}
            onChange={(event) => setDescription(event.target.value)}
          />
        </Field>

        <Field>
          <FieldLabel htmlFor="project-repo">
            Repositories
            {picked.length > 0 && (
              <span className="font-normal text-muted-foreground">{picked.length}</span>
            )}
          </FieldLabel>
          {picked.length > 0 && (
            <ul className="flex flex-wrap gap-2">
              {picked.map((repo) => (
                <li key={repo}>
                  <span className="flex h-9 items-center gap-1 rounded-full bg-muted pr-0.5 pl-3 text-sm">
                    <span className="max-w-56 truncate">{repo}</span>
                    {/* The chip is 36px; the button's hit area reaches 44px past it. */}
                    <button
                      type="button"
                      onClick={() => toggle(repo)}
                      aria-label={`Remove ${repo}`}
                      className="relative flex size-8 items-center justify-center rounded-full text-muted-foreground outline-none after:absolute after:-inset-1 hover:bg-background hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
                    >
                      <XIcon className="size-4" />
                    </button>
                  </span>
                </li>
              ))}
            </ul>
          )}
          {!github ? (
            <p className="flex items-center gap-2 text-sm text-muted-foreground">
              <Spinner className="size-4" /> Checking GitHub…
            </p>
          ) : github.connected ? (
            <div className="flex flex-col gap-2">
              <InputGroup className="h-11">
                <InputGroupAddon>
                  <SearchIcon />
                </InputGroupAddon>
                <InputGroupInput
                  id="project-repo"
                  placeholder={github.login ? `Search ${github.login}'s repositories` : "Search"}
                  autoComplete="off"
                  value={query}
                  onChange={(event) => setQuery(event.target.value)}
                />
              </InputGroup>
              <ul className="flex max-h-64 flex-col overflow-y-auto rounded-2xl border p-1">
                {!repos ? (
                  <li className="flex items-center gap-2 px-3 py-3 text-sm text-muted-foreground">
                    <Spinner className="size-4" /> Loading repositories…
                  </li>
                ) : shown.length === 0 ? (
                  <li className="px-3 py-3 text-sm text-muted-foreground">No matches.</li>
                ) : (
                  shown.map((r) => {
                    const on = picked.includes(r.fullName)
                    return (
                      <li key={r.fullName}>
                        <button
                          type="button"
                          role="checkbox"
                          aria-checked={on}
                          onClick={() => toggle(r.fullName)}
                          className="flex min-h-11 w-full items-center gap-3 rounded-xl px-3 py-2 text-left outline-none hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring"
                        >
                          <span
                            className={cn(
                              "flex size-5 shrink-0 items-center justify-center rounded-md border",
                              on && "border-primary bg-primary text-primary-foreground",
                            )}
                          >
                            {on && <CheckIcon className="size-3.5" />}
                          </span>
                          <span className="flex min-w-0 flex-col">
                            <span className="flex items-center gap-1.5 text-sm font-medium">
                              <span className="min-w-0 truncate">{r.fullName}</span>
                              {r.private && (
                                <LockIcon className="size-3 shrink-0 text-muted-foreground" />
                              )}
                            </span>
                            {r.description && (
                              <span className="truncate text-xs text-muted-foreground">
                                {r.description}
                              </span>
                            )}
                          </span>
                        </button>
                      </li>
                    )
                  })
                )}
              </ul>
            </div>
          ) : (
            <div className="flex flex-col gap-3">
              <div className="flex gap-2">
                <Input
                  id="project-repo"
                  className="h-11 flex-1"
                  placeholder="owner/name"
                  autoComplete="off"
                  autoCapitalize="none"
                  spellCheck={false}
                  value={query}
                  onChange={(event) => setQuery(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key !== "Enter") return
                    event.preventDefault()
                    add()
                  }}
                />
                <Button
                  type="button"
                  variant="outline"
                  size="icon-lg"
                  className="size-11 rounded-full"
                  onClick={add}
                  disabled={!canAdd}
                  aria-label="Add repository"
                >
                  <PlusIcon />
                </Button>
              </div>
              <div className="flex flex-col gap-2 rounded-2xl bg-muted/60 p-3 text-sm">
                <p>
                  {github.error ?? `No GitHub account on ${profile.name}'s server.`} Sign in there
                  to pick from your repositories and clone private ones:
                </p>
                <CopyBlock label="Copy sign-in command" text={CONNECT_GITHUB} />
              </div>
            </div>
          )}
        </Field>

        {error && (
          <p className="flex items-start gap-2 text-sm text-destructive" role="alert">
            <CircleAlertIcon className="mt-0.5 size-4 shrink-0" />
            <span className="min-w-0 break-words">{error}</span>
          </p>
        )}

        <Button type="submit" size="lg" className="h-11 rounded-full" disabled={!valid || creating}>
          {creating ? (
            <>
              <Spinner /> {picked.length ? "Cloning…" : "Creating…"}
            </>
          ) : (
            "Create project"
          )}
        </Button>
      </fieldset>
    </form>
  )
}

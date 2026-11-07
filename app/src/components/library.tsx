import { useCallback, useMemo, useState } from "react"
import { ChevronDownIcon, FileIcon, FileTextIcon, FolderIcon, ImageIcon } from "lucide-react"

import { PreviewerProvider, usePreviewerAbove } from "@/components/chat/previewer"
import { SortMenu } from "@/components/sort-menu"
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible"
import { cooldown, lacksRoute } from "@/lib/cooldown"
import { byName } from "@/lib/compare"
import { connectionKey } from "@/lib/connection"
import type { LibrarySort } from "@/lib/db"
import { useStoredSort } from "@/lib/use-sort"
import { defaultSort, withDir, type Sort, type SortKey } from "@/lib/sort"
import { LIST_MS, READ_TIMEOUT_MS } from "@/lib/freshness"
import {
  getProjectLibrary,
  getSessionLibrary,
  type HermesConfig,
  type LibraryFile,
  type LibraryFolder,
} from "@/lib/hermes"
import { mediaKind } from "@/lib/media-kind"
import { useOpenHostFile } from "@/lib/media-open"
import { usePoll } from "@/lib/poll"
import { noteFailure } from "@/lib/report"
import { cn } from "@/lib/utils"

/** Bots whose plugin has no library routes (an older plugin). */
const unsupported = cooldown()

// The icon a file's row wears, which is a look rather than a rule: what the row's tap does is decided
// by the host's answer, through `useOpenHostFile`. A note's icon is worth a list of its own; a photo's
// is `mediaKind`'s, since that is the rule the Previewer reads.
const TEXT_FILE = /\.(md|markdown|txt|csv|json|pdf)$/i
const ICONS = { image: ImageIcon, text: FileTextIcon, file: FileIcon } as const

/** What a name's row looks like, from what the file is. */
const iconOf = (name: string): keyof typeof ICONS =>
  mediaKind(undefined, name) === "image" ? "image" : TEXT_FILE.test(name) ? "text" : "file"

/** The keys the tree ranks by, each with the way it reads best (ADR 0091). */
const LIBRARY_SORTS: readonly SortKey<LibrarySort>[] = [
  { key: "date", label: "Date", dir: "desc" },
  { key: "name", label: "Name", dir: "asc" },
]

/** What an older build wrote — the direction baked into the key — and what it meant. */
const LEGACY_LIBRARY_SORTS: Record<string, Sort<LibrarySort>> = {
  new: { key: "date", dir: "desc" },
  old: { key: "date", dir: "asc" },
  az: { key: "name", dir: "asc" },
  za: { key: "name", dir: "desc" },
}

/** The Library tab's order, kept on this device. */
function useLibrarySort(): [Sort<LibrarySort>, (sort: Sort<LibrarySort>) => void] {
  return useStoredSort(LIBRARY_SORTS, ["librarySort", "librarySortDir"], LEGACY_LIBRARY_SORTS)
}

/** A session's library draws no sort control; its files read newest first, as they always have. */
const NEWEST_FIRST: Sort<LibrarySort> = defaultSort(LIBRARY_SORTS)

/**
 * One file under a folder: its kind's icon and its name, and a tap that opens it the way the app
 * opens any file the host holds — the Previewer for a photo, a clip or a recording, and the
 * platform for what the Previewer can't draw.
 */
function FileRow({ config, file }: { config: HermesConfig; file: LibraryFile }) {
  const { open, busy } = useOpenHostFile(config)
  const Icon = ICONS[iconOf(file.name)]
  return (
    <button
      type="button"
      onClick={() => open(file)}
      aria-busy={busy || undefined}
      className={cn(
        "-mx-2 flex min-h-11 w-[calc(100%+1rem)] items-center gap-3 rounded-xl px-2 text-left outline-none hover:bg-muted/60 focus-visible:ring-2 focus-visible:ring-ring",
        busy && "opacity-50",
      )}
    >
      <Icon className="size-4 shrink-0 text-muted-foreground" />
      <span className="min-w-0 flex-1 truncate text-sm">{file.name}</span>
    </button>
  )
}

/** The sessions that filed a folder's files, by their worktree's name. */
function sessionsOf(folder: LibraryFolder, titles: Map<string, string>) {
  const names = folder.files.map((file) => titles.get(file.worktree) ?? file.worktree)
  return [...new Set(names)].join(", ")
}

/** A folder's date: its newest file's. */
function newestAt(folder: LibraryFolder) {
  return folder.files.reduce((newest, file) => Math.max(newest, file.at), -Infinity)
}

/**
 * The tree in the chosen order: folders by their newest file or their name, and each folder's own
 * files the same way. Names compare the way the sidebar's do — case-blind, digits as numbers.
 */
function sortFolders(folders: LibraryFolder[], sort: Sort<LibrarySort>): LibraryFolder[] {
  const alphabetical = sort.key === "name"
  const by = (compare: number) => withDir(compare, sort.dir)
  const files = (folder: LibraryFolder) =>
    [...folder.files].sort((a, b) =>
      alphabetical ? by(byName(a.name, b.name)) : by(a.at - b.at),
    )
  return [...folders]
    .sort((a, b) => (alphabetical ? by(byName(a.name, b.name)) : by(newestAt(a) - newestAt(b))))
    .map((folder) => ({ ...folder, files: files(folder) }))
}

/** One folder of the tree: its files, folded away until the folder itself is tapped. */
function FolderSection({
  config,
  folder,
  titles,
  own,
}: {
  config: HermesConfig
  folder: LibraryFolder
  /** Each session's title by its worktree's name; left out for a session's own tree, one session's. */
  titles?: Map<string, string>
  /** A session's own tree: folders close together, and room under one that's open. */
  own?: boolean
}) {
  const sessions = titles ? sessionsOf(folder, titles) : ""
  return (
    <Collapsible defaultOpen={false} render={<section />}>
      <CollapsibleTrigger className="group flex min-h-11 w-full items-center gap-3 rounded-xl px-2 py-2 text-left outline-none hover:bg-muted/60 focus-visible:ring-2 focus-visible:ring-ring">
        <span className="flex size-10 shrink-0 items-center justify-center rounded-xl bg-muted">
          <FolderIcon className="size-5 text-muted-foreground" />
        </span>
        <span className="min-w-0 flex-1">
          <span className="block truncate font-medium">{folder.name}</span>
          {sessions && (
            <span className="block truncate text-sm text-muted-foreground">{sessions}</span>
          )}
        </span>
        <ChevronDownIcon className="size-4 shrink-0 text-muted-foreground transition-transform group-data-panel-open:rotate-180 motion-reduce:transition-none" />
      </CollapsibleTrigger>
      <CollapsibleContent>
        <div className={cn("space-y-0.5 pl-[3.25rem]", own && "pb-3")}>
          {folder.files.map((file) => (
            <FileRow key={file.path} config={config} file={file} />
          ))}
        </div>
      </CollapsibleContent>
    </Collapsible>
  )
}

/**
 * Reads a library while it's on screen, at most every minute; a plugin without the routes (an older
 * one) is left alone for five minutes. Shared by a project's Library tab and a session's outputs,
 * which read the same tree from the project's route and the session's.
 */
function useLibraryRead(
  config: HermesConfig,
  load: (signal: AbortSignal) => Promise<LibraryFolder[]>,
  active: boolean,
) {
  const [folders, setFolders] = useState<LibraryFolder[]>([])
  const key = connectionKey(config)
  const read = useCallback(
    (signal: AbortSignal) => {
      if (unsupported.cooling(key)) return
      // A read that never answers is treated as lost rather than left hanging on the host.
      void load(AbortSignal.any([signal, AbortSignal.timeout(READ_TIMEOUT_MS)]))
        .then((found) => {
          unsupported.clear(key)
          if (signal.aborted) return
          setFolders(found)
        })
        .catch((error: unknown) => {
          noteFailure("Reading a library", error)
          void lacksRoute(config, error, "library").then((missing) => {
            if (missing) unsupported.start(key)
          })
        })
    },
    [config, key, load],
  )
  usePoll(read, LIST_MS, [], { active })
  return folders
}

/**
 * A library as a tree: each folder — named after the flow its files belong to — with the sessions
 * that filed it, folded away until it's tapped, in the `order` it is handed. A session's own tree
 * (`own`) is one session's files: no second line, its folders close together with room under an open
 * one, and no sort menu of its own.
 */
export function LibraryTree({
  config,
  folders,
  titles,
  own,
  order,
  onSort,
}: {
  config: HermesConfig
  folders: LibraryFolder[]
  /** Each session's title by its worktree's name, for a folder's second line. */
  titles?: Map<string, string>
  /** A session's own files, rather than a project's across its sessions. */
  own?: boolean
  /** The order its folders and files are shown in. */
  order: Sort<LibrarySort>
  /** Changes the order; left out, the tree carries no sort menu. */
  onSort?: (sort: Sort<LibrarySort>) => void
}) {
  const ordered = useMemo(() => sortFolders(folders, order), [folders, order])
  // Read before the empty-tree return: a hook after it runs only once the tree fills, which is a
  // render with more hooks than the one before.
  const above = usePreviewerAbove()
  if (!folders.length) {
    return (
      <p className="px-3 py-8 text-center text-sm text-muted-foreground sm:px-4">No files yet.</p>
    )
  }
  const tree = (
    <div className="px-3 pb-4 sm:px-4">
      {onSort && (
        <div className="sticky top-0 z-10 flex justify-end bg-background py-2">
          <SortMenu by="the library" options={LIBRARY_SORTS} value={order} onSort={onSort} />
        </div>
      )}
      <div className={cn("space-y-6", own && "space-y-1 pt-2")}>
        {ordered.map((folder) => (
          <FolderSection
            key={folder.name}
            config={config}
            folder={folder}
            titles={titles}
            own={own}
          />
        ))}
      </div>
    </div>
  )
  // The tree brings the Previewer its own rows tap into, so a screen that mounts it can't hand every
  // tap the inert face a missing provider gives — and a screen that already mounts one (a chat with
  // its outputs drawer) keeps that one, rather than opening a second the screen's own controls
  // could never reach.
  return above ? tree : <PreviewerProvider>{tree}</PreviewerProvider>
}

/**
 * A project's Library tab: every session's filed files as a tree, read from the plugin's project
 * route while the tab is on screen.
 *
 * The tree stays in this component's state on purpose: nothing else reads it, and `TabsContent`
 * unmounts the panel when another tab is selected, so the state goes with it. A shared per-server
 * cache is for what two or more screens must agree on (see `src/lib/projects.ts`).
 */
export function LibraryTab({
  config,
  projectId,
  titles,
  active,
}: {
  config: HermesConfig
  projectId: string
  /** Each session's title by its worktree's name, for a folder's second line. */
  titles: Map<string, string>
  active: boolean
}) {
  const load = useCallback(
    (signal: AbortSignal) => getProjectLibrary(config, projectId, signal),
    [config, projectId],
  )
  const folders = useLibraryRead(config, load, active)
  const [sort, setSort] = useLibrarySort()
  return (
    <LibraryTree config={config} folders={folders} titles={titles} order={sort} onSort={setSort} />
  )
}

/**
 * One session's own filed files, read from the plugin's session route while the drawer is open: only
 * the folders that session filed into, listed newest first with nothing else on the row.
 */
export function SessionLibrary({
  config,
  sessionId,
  active,
}: {
  config: HermesConfig
  sessionId: string
  active: boolean
}) {
  const load = useCallback(
    async (signal: AbortSignal) => (await getSessionLibrary(config, sessionId, signal)).folders,
    [config, sessionId],
  )
  const folders = useLibraryRead(config, load, active)
  return <LibraryTree config={config} folders={folders} own order={NEWEST_FIRST} />
}

import { useCallback, useMemo, useState } from "react"
import { useLiveQuery } from "dexie-react-hooks"
import {
  ChevronDownIcon,
  FileIcon,
  FileTextIcon,
  FolderIcon,
  ImageIcon,
} from "lucide-react"

import { SortMenu } from "@/components/sort-menu"
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible"
import { cooldown, lacksRoute } from "@/lib/cooldown"
import { byName } from "@/lib/compare"
import { connectionKey } from "@/lib/connection"
import { getSettings, saveSettings, type LibrarySort } from "@/lib/db"
import { LIST_MS, READ_TIMEOUT_MS } from "@/lib/freshness"
import {
  getLibraryFile,
  getProjectLibrary,
  getSessionLibrary,
  type HermesConfig,
  type LibraryFile,
  type LibraryFolder,
} from "@/lib/hermes"
import { openExternal, openMediaViewer } from "@/lib/native"
import { usePoll } from "@/lib/poll"
import { noteFailure, quietly } from "@/lib/report"
import { cn } from "@/lib/utils"

/** Bots whose plugin has no library routes (an older plugin). */
const unsupported = cooldown()

// The kind decides the icon and how a tap opens the file; the bytes come back with the content
// type the plugin's route gives them (media.content_type), which covers the same extensions.
const IMAGE_FILE = /\.(png|jpe?g|gif|webp|bmp|svg)$/i
const TEXT_FILE = /\.(md|markdown|txt|csv|json|pdf)$/i

const LIBRARY_SORTS: Record<LibrarySort, string> = {
  new: "Newest",
  old: "Oldest",
  az: "A–Z",
  za: "Z–A",
}

/** The Library tab's order, kept on this device. */
function useLibrarySort(): [LibrarySort, (sort: LibrarySort) => void] {
  const sort = useLiveQuery(async () => (await getSettings()).librarySort, []) ?? "new"
  return [sort, (librarySort) => void saveSettings({ librarySort })]
}

/** A library file's kind, for its icon and how it opens. */
function kindOf(name: string) {
  if (IMAGE_FILE.test(name)) return "image"
  if (TEXT_FILE.test(name)) return "text"
  return "file"
}

/** Opens a library file: an image in the system viewer, anything else in a new tab. */
function openFile(config: HermesConfig, file: LibraryFile) {
  void getLibraryFile(config, file.path, AbortSignal.timeout(READ_TIMEOUT_MS))
    .then(async (blob) => {
      const url = URL.createObjectURL(blob)
      if (kindOf(file.name) !== "image") {
        openExternal(url)
        // The tab reads the URL after this returns, so its object URL outlives the click.
        window.setTimeout(() => URL.revokeObjectURL(url), 60_000)
        return
      }
      try {
        await openMediaViewer(url, { type: "image/*" })
      } finally {
        URL.revokeObjectURL(url)
      }
    })
    .catch(quietly("Opening a library file"))
}

/** One file under a folder: its kind's icon and its name, nothing more. */
function FileRow({ config, file }: { config: HermesConfig; file: LibraryFile }) {
  const kind = kindOf(file.name)
  const Icon = kind === "image" ? ImageIcon : kind === "text" ? FileTextIcon : FileIcon
  return (
    <button
      type="button"
      onClick={() => openFile(config, file)}
      className="-mx-2 flex min-h-11 w-[calc(100%+1rem)] items-center gap-3 rounded-xl px-2 text-left outline-none hover:bg-muted/60 focus-visible:ring-2 focus-visible:ring-ring"
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
function sortFolders(folders: LibraryFolder[], sort: LibrarySort): LibraryFolder[] {
  const alphabetical = sort === "az" || sort === "za"
  const desc = sort === "new" || sort === "za"
  const name = (a: string, b: string) => byName(a, b) * (desc ? -1 : 1)
  const files = (folder: LibraryFolder) =>
    [...folder.files].sort((a, b) =>
      alphabetical ? name(a.name, b.name) : (a.at - b.at) * (desc ? -1 : 1),
    )
  return [...folders]
    .sort((a, b) => (alphabetical ? name(a.name, b.name) : (newestAt(a) - newestAt(b)) * (desc ? -1 : 1)))
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
  order: LibrarySort
  /** Changes the order; left out, the tree carries no sort menu. */
  onSort?: (sort: LibrarySort) => void
}) {
  const ordered = useMemo(() => sortFolders(folders, order), [folders, order])
  if (!folders.length) {
    return (
      <p className="px-3 py-8 text-center text-sm text-muted-foreground sm:px-4">No files yet.</p>
    )
  }
  return (
    <div className="px-3 pb-4 sm:px-4">
      {onSort && (
        <div className="sticky top-0 z-10 flex justify-end bg-background py-2">
          <SortMenu
            by="the library"
            options={LIBRARY_SORTS}
            value={order}
            onSort={onSort}
          />
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
  return <LibraryTree config={config} folders={folders} own order="new" />
}

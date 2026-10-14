import { useCallback, useState } from "react"
import { FileIcon, FileTextIcon, FolderIcon, ImageIcon } from "lucide-react"

import { cooldown, lacksRoute } from "@/lib/cooldown"
import { connectionKey } from "@/lib/connection"
import { LIST_MS } from "@/lib/freshness"
import {
  getLibraryFile,
  getProjectLibrary,
  type HermesConfig,
  type LibraryFile,
  type LibraryFolder,
} from "@/lib/hermes"
import { openImageViewer } from "@/lib/native"
import { usePoll } from "@/lib/poll"
import { quietly } from "@/lib/report"

/** Bots whose plugin has no library routes (an older plugin). */
const unsupported = cooldown()

const IMAGE_FILE = /\.(png|jpe?g|gif|webp|bmp|svg)$/i
const TEXT_FILE = /\.(md|markdown|txt|csv|json)$/i

/** A library file's kind, for its icon and how it opens. */
function kindOf(name: string) {
  if (IMAGE_FILE.test(name)) return "image"
  if (TEXT_FILE.test(name)) return "text"
  return "file"
}

/** Opens a library file: an image in the system viewer, anything else in a new tab. */
function openFile(config: HermesConfig, file: LibraryFile) {
  void getLibraryFile(config, file.path)
    .then(async (blob) => {
      const url = URL.createObjectURL(blob)
      if (kindOf(file.name) !== "image") {
        window.open(url, "_blank", "noopener")
        // The tab reads the URL after this returns, so its object URL outlives the click.
        window.setTimeout(() => URL.revokeObjectURL(url), 60_000)
        return
      }
      try {
        await openImageViewer(url)
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

/**
 * The project's Library as a tree: each folder — named after the flow its files belong to — with
 * the session that filed it, its files beneath. Read from the plugin's library routes while the
 * tab is on screen, at most every minute; a plugin without them (an older one) is left alone for
 * five minutes.
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
  const [folders, setFolders] = useState<LibraryFolder[]>([])
  const key = connectionKey(config)
  const read = useCallback(() => {
    if (unsupported.cooling(key)) return
    void getProjectLibrary(config, projectId)
      .then((found) => {
        unsupported.clear(key)
        setFolders(found)
      })
      .catch((error: unknown) => {
        void lacksRoute(config, error, "library").then((missing) => {
          if (missing) unsupported.start(key)
        })
      })
  }, [config, projectId, key])
  usePoll(read, LIST_MS, [], { active })
  if (!folders.length) {
    return (
      <p className="px-3 py-8 text-center text-sm text-muted-foreground sm:px-4">No files yet.</p>
    )
  }
  return (
    <div className="space-y-6 px-3 py-4 sm:px-4">
      {folders.map((folder) => (
        <section key={folder.name}>
          <div className="flex items-center gap-3 px-2 py-2">
            <span className="flex size-10 shrink-0 items-center justify-center rounded-xl bg-muted">
              <FolderIcon className="size-5 text-muted-foreground" />
            </span>
            <span className="min-w-0 flex-1">
              <span className="block truncate font-medium">{folder.name}</span>
              <span className="block truncate text-sm text-muted-foreground">
                {sessionsOf(folder, titles)}
              </span>
            </span>
          </div>
          <div className="space-y-0.5 pl-[3.25rem]">
            {folder.files.map((file) => (
              <FileRow key={file.path} config={config} file={file} />
            ))}
          </div>
        </section>
      ))}
    </div>
  )
}

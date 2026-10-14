import { useCallback, useState } from "react"
import { FileIcon, FileTextIcon, ImageIcon } from "lucide-react"

import { formatBytes } from "@/lib/attachments"
import { cooldown, lacksRoute } from "@/lib/cooldown"
import { connectionKey } from "@/lib/connection"
import { formatRelative } from "@/lib/format"
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
        window.setTimeout(() => URL.revokeObjectURL(url), 60_000)
        return
      }
      await openImageViewer(url)
      URL.revokeObjectURL(url)
    })
    .catch(() => undefined)
}

function FileRow({
  config,
  file,
  title,
  now,
}: {
  config: HermesConfig
  file: LibraryFile
  title?: string
  now: number
}) {
  const kind = kindOf(file.name)
  const Icon = kind === "image" ? ImageIcon : kind === "text" ? FileTextIcon : FileIcon
  const secondary = [title, formatBytes(file.size), formatRelative(file.at, now)]
    .filter(Boolean)
    .join(" · ")
  return (
    <button
      type="button"
      onClick={() => openFile(config, file)}
      className="-mx-2 flex min-h-14 w-[calc(100%+1rem)] items-center gap-3 rounded-2xl px-2 py-3 text-left outline-none hover:bg-muted/60 focus-visible:ring-2 focus-visible:ring-ring"
    >
      <span className="flex size-11 shrink-0 items-center justify-center rounded-xl bg-muted">
        <Icon className="size-5 text-muted-foreground" />
      </span>
      <span className="min-w-0 flex-1">
        <span className="block truncate font-medium">{file.name}</span>
        <span className="block truncate text-sm text-muted-foreground">{secondary}</span>
      </span>
    </button>
  )
}

/**
 * The project's Library: the files its sessions filed, as folders of files. Read from the plugin's
 * library routes while the tab is on screen, at most every minute; a plugin without them (an
 * older one) is left alone for five minutes.
 */
export function LibraryTab({
  config,
  projectId,
  titles,
  active,
}: {
  config: HermesConfig
  projectId: string
  /** Each session's title by its worktree's name, for a file's second line. */
  titles: Map<string, string>
  active: boolean
}) {
  const [tree, setTree] = useState<{ folders: LibraryFolder[]; at: number }>({
    folders: [],
    at: 0,
  })
  const key = connectionKey(config)
  const read = useCallback(() => {
    if (unsupported.cooling(key)) return
    void getProjectLibrary(config, projectId)
      .then((found) => {
        unsupported.clear(key)
        setTree({ folders: found, at: Date.now() })
      })
      .catch((error: unknown) => {
        void lacksRoute(config, error, "library").then((missing) => {
          if (missing) unsupported.start(key)
        })
      })
  }, [config, projectId, key])
  usePoll(read, LIST_MS, [], { active })
  if (!tree.folders.length) {
    return (
      <p className="px-3 py-8 text-center text-sm text-muted-foreground sm:px-4">No files yet.</p>
    )
  }
  return (
    <div className="space-y-6 px-3 py-4 sm:px-4">
      {tree.folders.map((folder) => (
        <section key={folder.name}>
          <h2 className="px-2 pb-1 text-sm font-medium text-muted-foreground">
            {folder.name} · {folder.files.length}
          </h2>
          <div>
            {folder.files.map((file) => (
              <FileRow
                key={file.path}
                config={config}
                file={file}
                title={titles.get(file.worktree)}
                now={tree.at}
              />
            ))}
          </div>
        </section>
      ))}
    </div>
  )
}

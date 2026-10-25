import { ArrowLeftIcon, ChevronRightIcon, Trash2Icon } from "lucide-react"
import { useCallback, useEffect, useRef, useState } from "react"
import { useNavigate } from "react-router"
import { toast } from "sonner"

import { Markdown } from "@/components/chat/markdown"
import { Group, linkRowClass, RowText } from "@/components/settings-chrome"
import { Button } from "@/components/ui/button"
import { Spinner } from "@/components/ui/spinner"
import { botTabPath } from "@/lib/bot-tabs"
import type { Profile } from "@/lib/db"
import { READ_TIMEOUT_MS } from "@/lib/freshness"
import { getSkillFile, getSkillView, type SkillFile, type SkillView } from "@/lib/hermes"
import { skillDocument } from "@/lib/skill-frontmatter"
import { skillOrigin, skillSetup } from "@/lib/skills-tab"

type Reading = { status: "reading" } | { status: "ok"; view: SkillView }

type OpenFile = { status: "reading"; path: string } | { status: "ok"; file: SkillFile }

type PropertyRow = { key: string; value: string; origin?: boolean; setup?: string }

/**
 * A skill's own note, in the page's place: its name at the head, its frontmatter facts, its prose
 * and the files it links to, with Remove where the Host offers one. It is a detail the route draws
 * rather than a sheet (ADR 0055), so the screen's back button is the way out.
 */
export function SkillDetail({
  profile,
  name,
  onRemove,
}: {
  profile: Profile
  name: string
  /** Remove's offer, where the Host offers a removal and this skill's origin has one behind it. */
  onRemove?: () => void
}) {
  const { baseUrl, apiKey } = profile
  const navigate = useNavigate()
  // Nothing the note could say about a skill the Host won't open: the tab takes the screen back.
  const leave = useCallback(
    () => navigate(botTabPath(profile.id, "skills"), { replace: true }),
    [navigate, profile.id],
  )
  const [reading, setReading] = useState<Reading>({ status: "reading" })
  const [file, setFile] = useState<OpenFile | null>(null)
  const fileRead = useRef<AbortController | null>(null)

  // A read carries both its own cancellation and the timeout no host read goes without.
  const bounded = (signal: AbortSignal) =>
    AbortSignal.any([signal, AbortSignal.timeout(READ_TIMEOUT_MS)])
  useEffect(() => {
    const controller = new AbortController()
    getSkillView({ baseUrl, apiKey }, name, bounded(controller.signal)).then(
      (view) => {
        if (!controller.signal.aborted) setReading({ status: "ok", view })
      },
      (error: unknown) => {
        if (controller.signal.aborted) return
        toast.error(error instanceof Error ? error.message : "Couldn't open that skill.")
        leave()
      },
    )
    return () => controller.abort()
  }, [baseUrl, apiKey, name, leave])

  // A file still being read when the note leaves the screen stops on the host too.
  useEffect(() => () => fileRead.current?.abort(), [])

  const back = () => {
    fileRead.current?.abort()
    fileRead.current = null
    setFile(null)
  }

  const openFile = async (path: string) => {
    fileRead.current?.abort()
    const controller = new AbortController()
    fileRead.current = controller
    setFile({ status: "reading", path })
    try {
      const read = await getSkillFile({ baseUrl, apiKey }, name, path, bounded(controller.signal))
      if (!controller.signal.aborted) setFile({ status: "ok", file: read })
    } catch (error) {
      if (controller.signal.aborted) return
      setFile(null)
      toast.error(error instanceof Error ? error.message : "Couldn't read that file.")
    }
  }

  return (
    <div className="flex flex-col gap-4" data-skill-sheet={name}>
      {/* The screen's title is the header's, so only a file's own way back is drawn here. */}
      {file && (
        <div className="flex items-center px-5">
          <Button
            variant="ghost"
            size="icon-lg"
            className="-ml-3 size-11 shrink-0"
            aria-label="Back to the skill"
            onClick={back}
          >
            <ArrowLeftIcon />
          </Button>
        </div>
      )}
      {file ? (
        <SkillFileBody file={file} />
      ) : reading.status === "reading" ? (
        <Pending />
      ) : (
        <SkillBody view={reading.view} onOpenFile={openFile} />
      )}
      {!file && reading.status === "ok" && onRemove && <RemoveSkill onRemove={onRemove} />}
    </div>
  )
}

/** The note's one destructive action, where the Host and the skill's origin both offer it. */
function RemoveSkill({ onRemove }: { onRemove: () => void }) {
  return (
    <Button
      type="button"
      variant="ghost"
      className="h-11 self-start rounded-full text-destructive"
      onClick={onRemove}
    >
      <Trash2Icon data-icon="inline-start" />
      Remove
    </Button>
  )
}

function Pending() {
  return (
    <div className="flex flex-1 items-center justify-center pb-8" data-skill-pending>
      <Spinner />
    </div>
  )
}

function SkillBody({ view, onOpenFile }: { view: SkillView; onOpenFile: (path: string) => void }) {
  const origin = skillOrigin(view)
  const setup = skillSetup(view)
  const note = skillDocument(view.content)
  // Each row carries the hooks it draws with, so nothing is derived from display copy at render.
  const properties: PropertyRow[] = [
    ...(origin ? [{ key: "Origin", value: origin, origin: true }] : []),
    ...setup.map((line) => ({
      key: line.label,
      value: line.text,
      setup: line.key,
    })),
    ...note.rows,
  ]
  const groups = Object.entries(view.linkedFiles ?? {}).filter(([, paths]) => paths.length > 0)
  return (
    <div className="flex flex-col gap-4">
      <PropertiesBlock rows={properties} />
      <Markdown>{note.body}</Markdown>
      {groups.length > 0 && (
        <div className="flex flex-col gap-3">
          <h3 className="px-5 text-xs font-medium text-muted-foreground">Linked files</h3>
          {groups.map(([group, paths]) => (
            <div key={group} className="flex flex-col gap-1" data-skill-files={group}>
              <h4 className="px-5 text-xs font-medium text-muted-foreground">{group}</h4>
              <Group>
                {paths.map((path) => (
                  <button
                    key={path}
                    type="button"
                    className={linkRowClass}
                    onClick={() => onOpenFile(path)}
                  >
                    <RowText title={path} />
                    <ChevronRightIcon className="size-5 shrink-0 text-muted-foreground" />
                  </button>
                ))}
              </Group>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

function SkillFileBody({ file }: { file: OpenFile }) {
  if (file.status === "reading") return <Pending />
  const markdown = file.file.path.toLowerCase().endsWith(".md")
  // A linked note reads the way the skill's own does: its frontmatter as its properties, its
  // words as prose. Anything else stays the code it is.
  const note = markdown ? skillDocument(file.file.content) : null
  return (
    <div className="flex flex-col gap-3" data-skill-file={file.file.path}>
      <h3 className="px-5 text-xs font-medium text-muted-foreground">{file.file.path}</h3>
      {note ? (
        <>
          <PropertiesBlock rows={note.rows} />
          <Markdown>{note.body}</Markdown>
        </>
      ) : (
        <SkillText text={file.file.content} label={file.file.path} />
      )}
    </div>
  )
}

function PropertiesBlock({ rows }: { rows: PropertyRow[] }) {
  if (rows.length === 0) return null
  return (
    <div className="rounded-2xl bg-muted/60 p-3" data-skill-properties>
      {rows.map(({ key, value, origin: originRow, setup: setupKey }) => (
        <div key={key} className="flex gap-3 py-0.5 text-sm">
          <span className="w-28 shrink-0 break-words text-muted-foreground" title={key}>
            {key}
          </span>
          <span
            className="min-w-0 flex-1 break-words whitespace-pre-wrap"
            data-skill-prop={key}
            data-skill-origin={originRow ? "" : undefined}
            data-skill-setup={setupKey}
          >
            {value || <span className="text-muted-foreground">Empty</span>}
          </span>
        </div>
      ))}
    </div>
  )
}

function SkillText({ text, label }: { text: string; label: string }) {
  return (
    <pre
      aria-label={label}
      className="max-h-80 overflow-auto rounded-2xl bg-muted p-4 font-mono text-xs break-words whitespace-pre-wrap text-foreground"
    >
      {text}
    </pre>
  )
}

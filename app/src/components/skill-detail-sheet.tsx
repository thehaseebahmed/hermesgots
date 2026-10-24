import { ArrowLeftIcon, ChevronRightIcon } from "lucide-react"
import { useEffect, useRef, useState, type ReactNode } from "react"
import { toast } from "sonner"

import { Popup, PopupContent, PopupHeader, PopupTitle } from "@/components/popup"
import { Group, linkRowClass, RowText } from "@/components/settings-chrome"
import { Button } from "@/components/ui/button"
import { Spinner } from "@/components/ui/spinner"
import {
  getSkillFile,
  getSkillView,
  type HermesConfig,
  type SkillFile,
  type SkillView,
} from "@/lib/hermes"
import { skillOrigin, skillSetup } from "@/lib/skills-tab"

/** How tall a skill's sheet is, held between its SKILL.md and one of its files. */
const SHEET_HEIGHT = "h-[min(34rem,85dvh)]"

/** The sheet's one read of the skill: still coming, or here. A failure closes the sheet instead. */
type Reading = { status: "reading" } | { status: "ok"; view: SkillView }

/** One of the skill's files, read on the tap that asked for it: still coming, or here. */
type OpenFile = { status: "reading"; path: string } | { status: "ok"; file: SkillFile }

/**
 * One skill's own sheet: where it came from, how ready its Host says it is, its SKILL.md as it is on
 * disk, and its linked files — each opened into the same sheet, with the way back in its header
 * (ADR 0045, "the row is a summary; the sheet is the thing itself").
 *
 * It reads that one skill when it opens and nothing else: the SKILL.md and the list of files its Host
 * says it holds, then one file at a time as one is tapped, so opening a file is never a read of the
 * directory around it. Nothing is kept on the device — a sheet is a look at the Host's own copy, and a
 * skill can change between two opens.
 *
 * The SKILL.md is shown as the text it is, in a plain monospaced block rather than through the chat's
 * markdown renderer: this is the file's own bytes, which is what its owner would edit on the host, and
 * the renderer is a lazy chunk the composer loads for replies. A server's Config tab reads its block
 * the same way.
 *
 * `footer` is where a sheet's own actions about the skill sit, under its content.
 */
export function SkillDetailSheet({
  config,
  name,
  onClose,
  footer,
}: {
  config: Pick<HermesConfig, "baseUrl" | "apiKey">
  /** The skill to read: the row whose title was tapped. */
  name: string
  /** Dismissing the sheet, which is also where a read that failed leaves it. */
  onClose: () => void
  footer?: ReactNode
}) {
  const { baseUrl, apiKey } = config
  const [reading, setReading] = useState<Reading>({ status: "reading" })
  const [file, setFile] = useState<OpenFile | null>(null)
  // The way out is the parent's, drawn afresh on every render of the tab: held here so the read below
  // runs once per skill and connection rather than once per parent render.
  const closing = useRef(onClose)
  useEffect(() => {
    closing.current = onClose
  }, [onClose])

  useEffect(() => {
    let live = true
    getSkillView({ baseUrl, apiKey }, name).then(
      (view) => {
        if (live) setReading({ status: "ok", view })
      },
      (error: unknown) => {
        if (!live) return
        // The Host's own sentence, with nothing half-drawn behind it: a sheet that can't read its
        // skill closes rather than sitting there empty.
        toast.error(error instanceof Error ? error.message : "Couldn't open that skill.")
        closing.current()
      },
    )
    return () => {
      live = false
    }
  }, [baseUrl, apiKey, name])

  const openFile = async (path: string) => {
    setFile({ status: "reading", path })
    try {
      setFile({ status: "ok", file: await getSkillFile({ baseUrl, apiKey }, name, path) })
    } catch (error) {
      // Back to the skill's own sheet, so the refusal leaves the one thing that was read on screen.
      setFile(null)
      toast.error(error instanceof Error ? error.message : "Couldn't read that file.")
    }
  }

  return (
    <Popup open onOpenChange={(next) => !next && onClose()}>
      <PopupContent initialFocus={false} fixedHeight={SHEET_HEIGHT}>
        <PopupHeader className="relative">
          {file && (
            <Button
              variant="ghost"
              size="icon-lg"
              className="absolute top-0 left-3 z-20 size-11"
              aria-label="Back to the skill"
              onClick={() => setFile(null)}
            >
              <ArrowLeftIcon />
            </Button>
          )}
          <PopupTitle>{name}</PopupTitle>
        </PopupHeader>
        {file ? (
          <SkillFileBody file={file} />
        ) : reading.status === "reading" ? (
          <Pending />
        ) : (
          <SkillBody view={reading.view} onOpenFile={openFile} footer={footer} />
        )}
      </PopupContent>
    </Popup>
  )
}

/** A sheet waiting on its one read: the heading it was opened by, and nothing invented under it. */
function Pending() {
  return (
    <div className="flex flex-1 items-center justify-center pb-8" data-skill-pending>
      <Spinner />
    </div>
  )
}

/** One skill, in the order its sheet reads it: origin, readiness, the file, then its files. */
function SkillBody({
  view,
  onOpenFile,
  footer,
}: {
  view: SkillView
  onOpenFile: (path: string) => void
  footer?: ReactNode
}) {
  const origin = skillOrigin(view)
  const setup = skillSetup(view)
  const groups = Object.entries(view.linkedFiles ?? {}).filter(([, paths]) => paths.length > 0)
  return (
    <div className="flex flex-col gap-4 px-4 pb-6" data-skill-sheet={view.name}>
      {origin && (
        <p className="text-sm text-muted-foreground" data-skill-origin>
          {origin}
        </p>
      )}
      {setup.map((line) => (
        <p key={line.label} className="text-sm" data-skill-setup={line.label.toLowerCase()}>
          <span className="text-muted-foreground">{line.label}</span> {line.text}
        </p>
      ))}
      <SkillText text={view.content} label="SKILL.md" />
      {groups.length > 0 && (
        <div className="flex flex-col gap-3">
          <h3 className="px-2 text-xs font-medium text-muted-foreground">Linked files</h3>
          {groups.map(([group, paths]) => (
            <div key={group} className="flex flex-col gap-1" data-skill-files={group}>
              <h4 className="px-2 text-xs font-medium text-muted-foreground">{group}</h4>
              <Group>
                {paths.map((path) => (
                  <button
                    key={path}
                    type="button"
                    className={linkRowClass}
                    aria-haspopup="dialog"
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
      {footer}
    </div>
  )
}

/** One of the skill's files, read on the tap that asked for it. */
function SkillFileBody({ file }: { file: OpenFile }) {
  if (file.status === "reading") return <Pending />
  return (
    <div className="flex flex-col gap-3 px-4 pb-6" data-skill-file={file.file.path}>
      <h3 className="px-2 text-xs font-medium text-muted-foreground">{file.file.path}</h3>
      <SkillText text={file.file.content} label={file.file.path} />
    </div>
  )
}

/**
 * One text as it is, in a block of its own that scrolls inside the sheet: a SKILL.md runs to pages,
 * and the sheet around it still has to reach its files.
 */
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

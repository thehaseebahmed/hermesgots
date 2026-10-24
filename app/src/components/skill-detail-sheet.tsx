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

const SHEET_HEIGHT = "h-[min(34rem,85dvh)]"

type Reading = { status: "reading" } | { status: "ok"; view: SkillView }

type OpenFile = { status: "reading"; path: string } | { status: "ok"; file: SkillFile }

export function SkillDetailSheet({
  config,
  name,
  onClose,
  footer,
}: {
  config: Pick<HermesConfig, "baseUrl" | "apiKey">
  name: string
  onClose: () => void
  footer?: ReactNode
}) {
  const { baseUrl, apiKey } = config
  const [reading, setReading] = useState<Reading>({ status: "reading" })
  const [file, setFile] = useState<OpenFile | null>(null)
  const opened = useRef(0)
  useEffect(
    () => () => {
      opened.current += 1
    },
    [],
  )

  useEffect(() => {
    let live = true
    getSkillView({ baseUrl, apiKey }, name).then(
      (view) => {
        if (live) setReading({ status: "ok", view })
      },
      (error: unknown) => {
        if (!live) return
        toast.error(error instanceof Error ? error.message : "Couldn't open that skill.")
        onClose()
      },
    )
    return () => {
      live = false
    }
  }, [baseUrl, apiKey, name, onClose])

  const back = () => {
    opened.current += 1
    setFile(null)
  }

  const openFile = async (path: string) => {
    const request = (opened.current += 1)
    setFile({ status: "reading", path })
    try {
      const read = await getSkillFile({ baseUrl, apiKey }, name, path)
      if (request === opened.current) setFile({ status: "ok", file: read })
    } catch (error) {
      if (request !== opened.current) return
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
              onClick={back}
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

function Pending() {
  return (
    <div className="flex flex-1 items-center justify-center pb-8" data-skill-pending>
      <Spinner />
    </div>
  )
}

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

function SkillFileBody({ file }: { file: OpenFile }) {
  if (file.status === "reading") return <Pending />
  return (
    <div className="flex flex-col gap-3 px-4 pb-6" data-skill-file={file.file.path}>
      <h3 className="px-2 text-xs font-medium text-muted-foreground">{file.file.path}</h3>
      <SkillText text={file.file.content} label={file.file.path} />
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

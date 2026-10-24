import { useRef, useState, type ChangeEvent } from "react"
import { CameraIcon, FileUpIcon, ImageIcon, PlusIcon, type LucideIcon } from "lucide-react"

import { Banner } from "@/components/banner"
import { ModeIcon, ModeOptions, type ModeSettings } from "@/components/chat/mode-menu"
import { Popup, PopupContent, PopupHeader, PopupTitle } from "@/components/popup"
import { Button } from "@/components/ui/button"
import type { SessionMode } from "@/lib/db"
import type { PluginFeatureAnswer } from "@/lib/features"
import { cn } from "@/lib/utils"
import { MODE_LABELS } from "@/lib/workspace"

type Source = "camera" | "photos" | "files"

const SOURCES: { id: Source; label: string; icon: LucideIcon }[] = [
  { id: "camera", label: "Camera", icon: CameraIcon },
  { id: "photos", label: "Photos", icon: ImageIcon },
  { id: "files", label: "Files", icon: FileUpIcon },
]

/** The composer's `+` button: photos and files to add to the message, and a session's mode. */
export function AttachMenu({
  disabled,
  files,
  imagesAvailable,
  onAdd,
  session,
}: {
  disabled?: boolean
  /** A project session's permission mode, picked in the same sheet. */
  session?: ModeSettings
  /**
   * What the bot's host answered about the plugin's `attachments` feature: Files reach Hermes only
   * through the plugin's upload route, so they are offered where the host advertises it. An answer
   * the host never gave is not a no, so it gets the reason that names the plugin itself.
   */
  files: PluginFeatureAnswer
  /** Camera and Photos send images the model has to read itself. */
  imagesAvailable: boolean
  onAdd: (files: File[]) => void
}) {
  const [open, setOpen] = useState(false)
  const button = useRef<HTMLButtonElement>(null)
  const inputs = useRef<Record<Source, HTMLInputElement | null>>({
    camera: null,
    photos: null,
    files: null,
  })

  const pick = (source: Source) => {
    setOpen(false)
    inputs.current[source]?.click()
  }

  const picked = (event: ChangeEvent<HTMLInputElement>) => {
    const files = [...(event.target.files ?? [])]
    // So picking the same file again still fires a change.
    event.target.value = ""
    if (files.length) onAdd(files)
  }

  const pickMode = (mode: SessionMode) => {
    if (!session || mode === session.mode) return setOpen(false)
    setOpen(false)
    session.onMode(mode)
  }

  // The mode isn't on screen any more, so one that changes what the agent may do marks the button.
  const flagged = session && session.mode !== "accept_edits"
  const filesAvailable = files === "yes"

  return (
    <>
      <Button
        ref={button}
        type="button"
        variant="ghost"
        size="icon-lg"
        className="relative size-11 shrink-0 rounded-full text-muted-foreground"
        aria-label={flagged ? `Add context, mode: ${MODE_LABELS[session.mode]}` : "Add context"}
        disabled={disabled}
        onClick={() => setOpen(true)}
      >
        <PlusIcon />
        {flagged && (
          <span className="absolute top-0.5 right-0.5 flex size-4 items-center justify-center rounded-full bg-primary text-primary-foreground ring-2 ring-background">
            <ModeIcon mode={session.mode} className="size-2.5!" />
          </span>
        )}
      </Button>
      <input
        ref={(el) => void (inputs.current.camera = el)}
        type="file"
        accept="image/*"
        capture="environment"
        className="hidden"
        onChange={picked}
      />
      <input
        ref={(el) => void (inputs.current.photos = el)}
        type="file"
        accept="image/*"
        multiple
        className="hidden"
        onChange={picked}
      />
      <input
        ref={(el) => void (inputs.current.files = el)}
        type="file"
        multiple
        className="hidden"
        onChange={picked}
      />
      <Popup open={open} onOpenChange={setOpen} anchor={button}>
        <PopupContent>
          <PopupHeader className="pb-2">
            <PopupTitle>Add context</PopupTitle>
          </PopupHeader>
          {!filesAvailable && (
            <div className="px-4 pb-4 sm:px-6">
              <Banner>
                {files === "no"
                  ? "File uploads need a newer Gots plugin."
                  : "File uploads need the Gots plugin."}
              </Banner>
            </div>
          )}
          <div
            className={cn(
              "grid grid-cols-3 gap-4 px-4 sm:gap-5 sm:px-6",
              session ? "pb-2" : "pb-24 md:pb-2",
            )}
          >
            {SOURCES.map(({ id, label, icon: Icon }) => (
              <Button
                key={id}
                type="button"
                variant="outline"
                className="h-auto min-h-24 flex-col gap-2 rounded-2xl py-5 text-[15px] font-normal"
                disabled={id === "files" ? !filesAvailable : !imagesAvailable}
                onClick={() => pick(id)}
              >
                <Icon className="size-6!" />
                {label}
              </Button>
            ))}
          </div>
          {session && (
            <section className="flex flex-col gap-2 px-4 pt-4 pb-24 sm:px-6 md:pb-2">
              <h3 className="px-1 text-sm text-muted-foreground">Mode</h3>
              <ModeOptions
                mode={session.mode}
                autoAvailable={session.autoAvailable}
                onPick={pickMode}
              />
            </section>
          )}
        </PopupContent>
      </Popup>
    </>
  )
}

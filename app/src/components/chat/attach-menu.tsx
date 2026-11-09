import { useRef, useState, type ChangeEvent } from "react"
import {
  CameraIcon,
  CheckIcon,
  CrosshairIcon,
  FileUpIcon,
  ImageIcon,
  PlusIcon,
  type LucideIcon,
} from "lucide-react"

import { ModeIcon, ModeOptions, type ModeSettings } from "@/components/chat/mode-menu"
import { Popup, PopupContent, PopupHeader, PopupTitle } from "@/components/popup"
import { Button } from "@/components/ui/button"
import { pickRoad } from "@/lib/attachment-caps"
import type { SessionMode } from "@/lib/db"
import type { PluginFeatureAnswer } from "@/lib/features"
import { tell } from "@/lib/tell"
import { cn } from "@/lib/utils"
import { MODE_LABELS } from "@/lib/workspace"

type Source = "camera" | "photos" | "files"

const SOURCES: { id: Source; label: string; icon: LucideIcon }[] = [
  { id: "camera", label: "Camera", icon: CameraIcon },
  { id: "photos", label: "Photos", icon: ImageIcon },
  { id: "files", label: "Files", icon: FileUpIcon },
]

/**
 * The composer's `+` button: photos, clips and files to add to the message, a session's mode, and —
 * on a canvas's screen — pointing at an element of the page. Pointing is a way to add context, as a
 * picture is, so it is asked for where the other ways are: the toolbar has room for the field, the
 * model and the send, and a fourth control beside them crowded all three.
 */
export function AttachMenu({
  disabled,
  filesFeature,
  imagesAvailable,
  onAdd,
  session,
  point,
}: {
  disabled?: boolean
  /** A project session's permission mode, picked in the same sheet. */
  session?: ModeSettings
  filesFeature: PluginFeatureAnswer
  /** Whether the model takes images, which decides whether a picture rides inline or as a file. */
  imagesAvailable: boolean
  onAdd: (files: File[]) => void
  /** A canvas's page: arming it waits for one tap on an element, which rides the next message. */
  point?: { armed: boolean; onArm: () => void }
}) {
  const [open, setOpen] = useState(false)
  const button = useRef<HTMLButtonElement>(null)
  const inputs = useRef<Record<Source, HTMLInputElement | null>>({
    camera: null,
    photos: null,
    files: null,
  })

  /** Which road one source's pick takes: the bytes the model reads, the host's file, or nowhere. */
  const roadOf = (source: Source) =>
    pickRoad({ picture: source !== "files", readsImages: imagesAvailable, route: filesFeature })

  const pick = (source: Source) => {
    const road = roadOf(source)
    // A source nothing can carry stays tappable and says why, so the sheet never leaves a dead
    // button to guess at; the sheet is left open with its sentence said.
    if (road.road === "none") return tell.error(road.message)
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

  const pickPoint = () => {
    setOpen(false)
    point?.onArm()
  }

  // The mode isn't on screen any more, so one that changes what the agent may do marks the button.
  const flagged = session && session.mode !== "accept_edits"

  return (
    <>
      <Button
        ref={button}
        type="button"
        variant="ghost"
        size="icon-lg"
        className="relative size-11 shrink-0 rounded-full text-muted-foreground"
        aria-label={
          point?.armed
            ? "Add context, pointing at the page"
            : flagged
              ? `Add context, mode: ${MODE_LABELS[session.mode]}`
              : "Add context"
        }
        disabled={disabled}
        onClick={() => setOpen(true)}
      >
        <PlusIcon />
        {flagged || point?.armed ? (
          <span className="absolute top-0.5 right-0.5 flex size-4 items-center justify-center rounded-full bg-primary text-primary-foreground ring-2 ring-background">
            {flagged ? (
              <ModeIcon mode={session.mode} className="size-2.5!" />
            ) : (
              <CrosshairIcon className="size-2.5!" />
            )}
          </span>
        ) : null}
      </Button>
      <input
        ref={(el) => void (inputs.current.camera = el)}
        name="camera"
        type="file"
        accept="image/*"
        capture="environment"
        className="hidden"
        onChange={picked}
      />
      {/* The gallery takes clips as well as photos: the Camera is the one that stays a still. */}
      <input
        ref={(el) => void (inputs.current.photos = el)}
        name="photos"
        type="file"
        accept="image/*,video/*"
        multiple
        className="hidden"
        onChange={picked}
      />
      <input
        ref={(el) => void (inputs.current.files = el)}
        name="files"
        type="file"
        multiple
        className="hidden"
        onChange={picked}
      />
      <Popup open={open} onOpenChange={setOpen} anchor={button}>
        <PopupContent toastAbove>
          <PopupHeader className="pb-2">
            <PopupTitle>Add context</PopupTitle>
          </PopupHeader>
          <div
            className={cn(
              "grid grid-cols-3 gap-4 px-4 sm:gap-5 sm:px-6",
              session || point ? "pb-2" : "pb-24 md:pb-2",
            )}
          >
            {SOURCES.map(({ id, label, icon: Icon }) => {
              // A refused source stays pressable — `disabled` would eat the tap that says why.
              const shut = roadOf(id).road === "none"
              return (
                <Button
                  key={id}
                  type="button"
                  variant="outline"
                  aria-disabled={shut || undefined}
                  className={cn(
                    "h-auto min-h-24 flex-col gap-2 rounded-2xl py-5 text-[15px] font-normal",
                    shut && "border-dashed text-muted-foreground",
                  )}
                  onClick={() => pick(id)}
                >
                  <Icon className="size-6!" />
                  {label}
                </Button>
              )
            })}
          </div>
          {point && (
            <section
              className={cn(
                "flex flex-col gap-2 px-4 pt-2 sm:px-6",
                session ? "pb-2" : "pb-24 md:pb-2",
              )}
            >
              {/* Named for what the rows are rather than for this one: the page is the first tool a
                  canvas's composer offers, and the group is where the next ones go. */}
              <h3 className="px-1 text-sm text-muted-foreground">Tools</h3>
              <div className="flex flex-col overflow-hidden rounded-2xl bg-muted/60 p-1">
                <button
                  type="button"
                  aria-pressed={point.armed}
                  aria-label={point.armed ? "Tap an element on the page" : "Point at the page"}
                  onClick={pickPoint}
                  className={cn(
                    "flex min-h-11 w-full items-center gap-3 rounded-xl px-3 py-2 text-left text-[15px] transition-colors hover:bg-background/60 focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:outline-none",
                    point.armed && "bg-background",
                  )}
                >
                  <CrosshairIcon className="size-4 shrink-0 text-muted-foreground" aria-hidden />
                  <span className="flex min-w-0 flex-1 flex-col">
                    <span>{point.armed ? "Tap an element on the page" : "Point at the page"}</span>
                    <span className="text-sm text-muted-foreground">
                      {point.armed
                        ? "Waiting for your tap."
                        : "Adds the element you tap to your message."}
                    </span>
                  </span>
                  {point.armed && <CheckIcon className="size-4 shrink-0 text-primary" aria-hidden />}
                </button>
              </div>
            </section>
          )}
          {session && (
            <section className="flex flex-col gap-2 px-4 pt-2 pb-24 sm:px-6 md:pb-2">
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

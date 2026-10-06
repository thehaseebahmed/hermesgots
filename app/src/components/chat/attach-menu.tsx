import { useRef, useState, type ChangeEvent } from "react"
import { CameraIcon, FileUpIcon, ImageIcon, PlusIcon, type LucideIcon } from "lucide-react"

import { Popup, PopupContent, PopupHeader, PopupTitle } from "@/components/popup"
import { Button } from "@/components/ui/button"

type Source = "camera" | "photos" | "files"

const SOURCES: { id: Source; label: string; icon: LucideIcon }[] = [
  { id: "camera", label: "Camera", icon: CameraIcon },
  { id: "photos", label: "Photos", icon: ImageIcon },
  { id: "files", label: "Files", icon: FileUpIcon },
]

/** The composer's `+` button: photos and files to add to the message. */
export function AttachMenu({
  disabled,
  filesAvailable,
  onAdd,
}: {
  disabled?: boolean
  /** Files only reach Hermes through the Memento plugin; photos also go inline. */
  filesAvailable: boolean
  onAdd: (files: File[]) => void
}) {
  const [open, setOpen] = useState(false)
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

  return (
    <>
      <Button
        type="button"
        variant="ghost"
        size="icon-lg"
        className="size-11 shrink-0 rounded-full text-muted-foreground"
        aria-label="Add context"
        disabled={disabled}
        onClick={() => setOpen(true)}
      >
        <PlusIcon />
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
      <Popup open={open} onOpenChange={setOpen}>
        <PopupContent>
          <PopupHeader className="items-center pb-2">
            <PopupTitle>Add context</PopupTitle>
          </PopupHeader>
          <div className="grid grid-cols-3 gap-4 px-4 pb-24 sm:gap-5 sm:px-6 md:pb-2">
            {SOURCES.map(({ id, label, icon: Icon }) => (
              <Button
                key={id}
                type="button"
                variant="outline"
                className="h-auto min-h-24 flex-col gap-2 rounded-2xl py-5 text-[15px] font-normal"
                disabled={id === "files" && !filesAvailable}
                onClick={() => pick(id)}
              >
                <Icon className="size-6!" />
                {label}
              </Button>
            ))}
          </div>
        </PopupContent>
      </Popup>
    </>
  )
}

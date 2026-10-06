import { CameraIcon, FileTextIcon, FolderIcon, ImageIcon, PlusIcon } from "lucide-react"

import { Button } from "@/components/ui/button"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"

// Nothing attaches yet; the entries are what the roadmap's composer-context phase wires up.
const SOURCES = [
  { label: "Project files", icon: FolderIcon },
  { label: "Camera", icon: CameraIcon },
  { label: "Photos", icon: ImageIcon },
  { label: "Documents", icon: FileTextIcon },
]

/** The composer's `+` button: context to add to the message. */
export function AttachMenu({ disabled }: { disabled?: boolean }) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        disabled={disabled}
        render={
          <Button
            type="button"
            variant="ghost"
            size="icon-lg"
            className="size-11 rounded-full text-muted-foreground"
            aria-label="Add"
          />
        }
      >
        <PlusIcon />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="min-w-44">
        {SOURCES.map(({ label, icon: Icon }) => (
          <DropdownMenuItem key={label} className="min-h-11" disabled>
            <Icon />
            {label}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

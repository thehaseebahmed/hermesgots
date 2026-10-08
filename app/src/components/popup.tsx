import type { ComponentProps, ReactNode } from "react"
import { Dialog } from "@base-ui/react/dialog"
import { XIcon } from "lucide-react"

import { Button } from "@/components/ui/button"
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet"
import { useWide } from "@/lib/media"
import { cn } from "@/lib/utils"

/**
 * The app's pop-up: a sheet from the bottom on phones, a centred dialog from tablet width up.
 * Both are the same dialog underneath, so the header, title and description work in either.
 * The content scrolls under its header, which stays put, and the close button with it.
 */
export const Popup = Sheet
export const PopupTitle = SheetTitle
export const PopupDescription = SheetDescription

export function PopupHeader({ className, ...props }: ComponentProps<typeof SheetHeader>) {
  return <SheetHeader className={cn("sticky top-0 z-10 bg-popover", className)} {...props} />
}

/** The scrolling part, so the header above stays pinned. */
function Scroll({ children }: { children: ReactNode }) {
  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-y-auto overscroll-contain">
      {children}
    </div>
  )
}
export function PopupContent({ className, children }: { className?: string; children: ReactNode }) {
  const wide = useWide()
  if (!wide)
    return (
      <SheetContent
        side="bottom"
        className={cn(
          "mx-auto max-h-[85dvh] w-full max-w-xl overflow-hidden rounded-t-3xl pb-[max(1.5rem,env(safe-area-inset-bottom))] data-[side=bottom]:border-t-0",
          className,
        )}
      >
        <Scroll>{children}</Scroll>
      </SheetContent>
    )
  return (
    <Dialog.Portal>
      <Dialog.Backdrop className="fixed inset-0 z-50 bg-black/80 transition-opacity duration-150 data-ending-style:opacity-0 data-starting-style:opacity-0 supports-backdrop-filter:backdrop-blur-xs" />
      <Dialog.Popup
        className={cn(
          "fixed top-1/2 left-1/2 z-50 flex max-h-[85dvh] w-[calc(100%-2rem)] max-w-lg -translate-x-1/2 -translate-y-1/2 flex-col overflow-hidden rounded-3xl bg-popover pb-6 text-sm text-popover-foreground shadow-lg transition duration-150 outline-none data-ending-style:scale-95 data-ending-style:opacity-0 data-starting-style:scale-95 data-starting-style:opacity-0",
          className,
        )}
      >
        <Scroll>{children}</Scroll>
        <Dialog.Close
          render={<Button variant="ghost" className="absolute top-4 right-4 z-20" size="icon-sm" />}
        >
          <XIcon />
          <span className="sr-only">Close</span>
        </Dialog.Close>
      </Dialog.Popup>
    </Dialog.Portal>
  )
}

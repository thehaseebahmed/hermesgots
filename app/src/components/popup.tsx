import { createContext, useContext, useRef, type ComponentProps, type ReactNode } from "react"
import { Dialog } from "@base-ui/react/dialog"
import { Drawer } from "@base-ui/react/drawer"
import { XIcon } from "lucide-react"

import { Button } from "@/components/ui/button"
import { SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet"
import { useWide, useXLarge } from "@/lib/media"
import { cn } from "@/lib/utils"

/**
 * The app's pop-up: a modal bottom sheet on phones, a centred dialog from tablet width up. Both are
 * the same dialog underneath, so the header, title and description work in either. The content
 * scrolls under its header, which stays put.
 *
 * The sheet follows Material 3's modal bottom sheet: a 32×4 drag handle in a 48px target, 28px top
 * corners, a 32% scrim, at most 640px wide, sized to its content, and dismissed by swiping it down,
 * tapping the scrim or the handle, Escape, or Android's back button (`handleBackButton`).
 *
 * A pop-up you read beside the chat rather than act in (`side`: tool details, an agent's transcript)
 * is a modal side sheet from 1280px instead, Material's place for supporting content: full height on
 * the right, swiped off to the right.
 */
export function Popup({ side, ...props }: ComponentProps<typeof Drawer.Root> & { side?: boolean }) {
  const sideSheet = useXLarge() && Boolean(side)
  return (
    <SideSheet.Provider value={sideSheet}>
      <Drawer.Root swipeDirection={sideSheet ? "right" : "down"} {...props} />
    </SideSheet.Provider>
  )
}
export const PopupTitle = SheetTitle
export const PopupDescription = SheetDescription

const InSheet = createContext(false)
const SideSheet = createContext(false)

export function PopupHeader({ className, ...props }: ComponentProps<typeof SheetHeader>) {
  const sheet = useContext(InSheet)
  return (
    <SheetHeader
      className={cn("sticky top-0 z-10 bg-popover", sheet && "pt-0", className)}
      {...props}
    />
  )
}

/** The scrolling part, so the header above stays pinned. */
function Scroll({ children }: { children: ReactNode }) {
  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-y-auto overscroll-contain">
      {children}
    </div>
  )
}

const SCRIM =
  "fixed inset-0 z-50 bg-black/32 transition-opacity data-ending-style:opacity-0 data-starting-style:opacity-0"

function PopupClose({ className }: { className?: string }) {
  return (
    <Dialog.Close
      render={
        <Button
          variant="ghost"
          className={cn("absolute top-4 right-4 z-20", className)}
          size="icon-sm"
        />
      }
    >
      <XIcon />
      <span className="sr-only">Close</span>
    </Dialog.Close>
  )
}

export function PopupContent({
  className,
  children,
  initialFocus,
  closeClassName,
}: {
  className?: string
  children: ReactNode
  closeClassName?: string
  /** `false` focuses the pop-up itself, so a search field doesn't take focus (and the keyboard) on open. */
  initialFocus?: boolean
}) {
  const popup = useRef<HTMLDivElement>(null)
  const focus = initialFocus === false ? popup : undefined
  const wide = useWide()
  const side = useContext(SideSheet)
  if (side)
    return (
      <Drawer.Portal>
        <Drawer.Backdrop
          className={cn(
            SCRIM,
            "opacity-[calc(1-var(--drawer-swipe-progress))] duration-300 data-ending-style:duration-[calc(var(--drawer-swipe-strength)*300ms)] data-swiping:duration-0 motion-reduce:duration-0",
          )}
        />
        <Drawer.Viewport className="fixed inset-0 z-50 flex justify-end">
          <Drawer.Popup
            ref={popup}
            initialFocus={focus}
            className={cn(
              "relative flex h-full w-[400px] max-w-[calc(100vw-3.5rem)] flex-col overflow-hidden rounded-l-2xl bg-popover pb-6 text-sm text-popover-foreground shadow-lg outline-none",
              "[transform:translateX(var(--drawer-swipe-movement-x))] transition-transform duration-300 ease-[cubic-bezier(0.2,0,0,1)] data-ending-style:[transform:translateX(100%)] data-ending-style:duration-[calc(var(--drawer-swipe-strength)*300ms)] data-starting-style:[transform:translateX(100%)] data-swiping:duration-0 data-swiping:select-none motion-reduce:duration-0",
              className,
            )}
          >
            <Drawer.Content className="flex min-h-0 flex-1 flex-col">
              <Scroll>{children}</Scroll>
            </Drawer.Content>
            <PopupClose className={closeClassName} />
          </Drawer.Popup>
        </Drawer.Viewport>
      </Drawer.Portal>
    )
  if (!wide)
    return (
      <Drawer.Portal>
        <Drawer.Backdrop
          className={cn(
            SCRIM,
            "opacity-[calc(1-var(--drawer-swipe-progress))] duration-300 data-ending-style:duration-[calc(var(--drawer-swipe-strength)*300ms)] data-swiping:duration-0 motion-reduce:duration-0",
          )}
        />
        <Drawer.Viewport className="fixed inset-0 z-50 flex items-end justify-center">
          <Drawer.Popup
            ref={popup}
            initialFocus={focus}
            className={cn(
              "relative flex max-h-[85dvh] w-full max-w-[640px] flex-col overflow-hidden rounded-t-[28px] bg-popover pb-[max(1.5rem,env(safe-area-inset-bottom))] text-sm text-popover-foreground shadow-lg outline-none",
              "[transform:translateY(var(--drawer-swipe-movement-y))] transition-transform duration-300 ease-[cubic-bezier(0.2,0,0,1)] data-ending-style:[transform:translateY(100%)] data-ending-style:duration-[calc(var(--drawer-swipe-strength)*300ms)] data-starting-style:[transform:translateY(100%)] data-swiping:duration-0 data-swiping:select-none motion-reduce:duration-0",
              className,
            )}
          >
            <Drawer.Close
              aria-label="Close"
              className="mx-auto flex h-12 w-16 shrink-0 cursor-grab touch-none items-center justify-center outline-none focus-visible:[&>span]:bg-ring"
            >
              <span className="h-1 w-8 rounded-full bg-muted-foreground/60" />
            </Drawer.Close>
            <InSheet.Provider value>
              <Drawer.Content className="flex min-h-0 flex-1 flex-col">
                <Scroll>{children}</Scroll>
              </Drawer.Content>
            </InSheet.Provider>
          </Drawer.Popup>
        </Drawer.Viewport>
      </Drawer.Portal>
    )
  return (
    <Dialog.Portal>
      <Dialog.Backdrop className={cn(SCRIM, "duration-150")} />
      <Dialog.Popup
        ref={popup}
        initialFocus={focus}
        className={cn(
          "fixed top-1/2 left-1/2 z-50 flex max-h-[85dvh] w-[calc(100%-2rem)] max-w-lg -translate-x-1/2 -translate-y-1/2 flex-col overflow-hidden rounded-3xl bg-popover pb-6 text-sm text-popover-foreground shadow-lg transition duration-150 outline-none data-ending-style:scale-95 data-ending-style:opacity-0 data-starting-style:scale-95 data-starting-style:opacity-0",
          className,
        )}
      >
        <Scroll>{children}</Scroll>
        <PopupClose className={closeClassName} />
      </Dialog.Popup>
    </Dialog.Portal>
  )
}

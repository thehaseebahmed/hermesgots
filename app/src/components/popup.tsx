import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  type ComponentProps,
  type ReactNode,
  type RefObject,
} from "react"
import { Dialog } from "@base-ui/react/dialog"
import { Drawer } from "@base-ui/react/drawer"
import { Popover } from "@base-ui/react/popover"
import { XIcon } from "lucide-react"

import { Button } from "@/components/ui/button"
import { SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet"
import { PopupFormContext, usePopupDrawer, usePopupForm, type PopupForm } from "@/lib/popup-form"
import { cn } from "@/lib/utils"

/**
 * What a pop-up is on this screen. Below 1024px a modal bottom sheet (full width on a phone, 640px
 * at most and centred on a tablet). From 1024px a side drawer: full height on the right, swiped off
 * to the right, a third of the viewport wide — never narrower than the 412px list pane it sits
 * beside, never wider than four thirds of it (549px). Material's line for side sheets, which "often
 * become bottom sheets on mobile". A small pick made from a button (the composer's `+` and model
 * pill, a model field) passes that button as `anchor` and is a menu beside it from 1024px instead,
 * since a drawer on the far right would move the eye across the screen for one tap.
 *
 * Confirmations aren't pop-ups: they stay `AlertDialog`s, a centred dialog on every screen. A
 * recording or a photo takes the whole screen (`FullscreenPopup`).
 */
export function Popup({
  anchor,
  open,
  onOpenChange,
  onOpenChangeComplete,
  children,
}: {
  open?: boolean
  onOpenChange?: (open: boolean) => void
  onOpenChangeComplete?: (open: boolean) => void
  /** The button the pop-up opens from: from 1024px it's a menu beside it rather than a drawer. */
  anchor?: RefObject<HTMLElement | null>
  children?: ReactNode
}) {
  const large = usePopupDrawer()
  const form: PopupForm = !large ? "sheet" : anchor ? "menu" : "drawer"
  return (
    <PopupFormContext.Provider value={form}>
      <Anchor.Provider value={anchor}>
        {form === "menu" ? (
          <Popover.Root
            open={open}
            onOpenChange={(next) => onOpenChange?.(next)}
            onOpenChangeComplete={onOpenChangeComplete}
          >
            {children}
          </Popover.Root>
        ) : (
          <Drawer.Root
            swipeDirection={form === "drawer" ? "right" : "down"}
            open={open}
            onOpenChange={(next) => onOpenChange?.(next)}
            onOpenChangeComplete={onOpenChangeComplete}
          >
            {children}
          </Drawer.Root>
        )}
      </Anchor.Provider>
    </PopupFormContext.Provider>
  )
}
/**
 * A pop-up's heading: centred in every form, like a Material bottom sheet's, and bounded so a long
 * one cuts with an ellipsis rather than running under the close button. A heading that sits beside
 * a control of the header's own passes `text-left`.
 */
export function PopupTitle({ className, ...props }: ComponentProps<typeof SheetTitle>) {
  const classes = cn(
    "cn-font-heading max-w-full justify-center truncate text-center text-base font-medium text-foreground",
    className,
  )
  // A menu's heading starts where its rows do, as it sits beside the button it opened from.
  if (usePopupForm() === "menu")
    return <Popover.Title {...props} className={cn(classes, "justify-start text-left")} />
  return <SheetTitle className={classes} {...props} />
}
export function PopupDescription(props: ComponentProps<typeof SheetDescription>) {
  if (usePopupForm() === "menu")
    return (
      <Popover.Description
        {...props}
        className={cn("text-sm text-muted-foreground", props.className as string)}
      />
    )
  return <SheetDescription {...props} />
}

const Anchor = createContext<RefObject<HTMLElement | null> | undefined>(undefined)
const HeaderSeen = createContext<() => void>(() => {})

export function PopupHeader({ className, children, ...props }: ComponentProps<typeof SheetHeader>) {
  const form = usePopupForm()
  const sheet = form === "sheet"
  const markHeaderSeen = useContext(HeaderSeen)
  useEffect(() => {
    markHeaderSeen()
  }, [markHeaderSeen])
  return (
    <SheetHeader
      className={cn(
        "sticky top-0 z-10 bg-popover pb-4",
        // The close button sits at a drawer header's right, so a drawer keeps that room clear; a
        // sheet has no close button (nor does a menu, dismissed by a press outside it).
        form === "drawer" && "pr-14",
        form === "menu" && "px-5 pt-4 pb-3",
        // A sheet centres its whole header, as a Material bottom sheet does, and has the drag
        // handle above the heading, so it takes no top padding. The heading centres itself in every
        // form (PopupTitle), leaving a drawer's or menu's other header rows as they were.
        sheet && "items-center pt-0 text-center",
        className,
      )}
      {...props}
    >
      {form === "drawer" && CLOSE}
      {children}
    </SheetHeader>
  )
}

/** The scrolling part, so the header above stays pinned. */
function Scroll({ children }: { children: ReactNode }) {
  return (
    <div
      data-slot="popup-scroll"
      className="flex min-h-0 flex-1 flex-col overflow-y-auto overscroll-contain"
    >
      {children}
    </div>
  )
}

const SCRIM =
  "fixed inset-0 z-50 bg-black/32 transition-opacity data-ending-style:opacity-0 data-starting-style:opacity-0"

const CLOSE = (
  <Dialog.Close
    render={
      <Button variant="ghost" className="absolute top-3 right-3 z-20 size-11" size="icon-lg" />
    }
  >
    <XIcon />
    <span className="sr-only">Close</span>
  </Dialog.Close>
)

/**
 * A pop-up's width as a sheet or a menu, `lg` (the default) unless a wider or narrower one is asked
 * for. A sheet is full width on a phone and 640px at most on a tablet, narrower only for `md`; a
 * drawer takes its own width, so a size never sets it.
 */
export type PopupSize = "md" | "lg" | "xl" | "2xl"

const SHEET_SIZE: Record<PopupSize, string> = {
  md: "sm:max-w-md",
  lg: "",
  xl: "",
  "2xl": "",
}

const MENU_SIZE: Record<PopupSize, string> = {
  md: "w-80",
  lg: "w-96",
  xl: "w-[28rem]",
  "2xl": "w-[32rem]",
}

export function PopupContent({
  className,
  fixedHeight,
  size = "lg",
  children,
  initialFocus,
}: {
  className?: string
  /** A sheet's height that holds between views of its content (a picker's list, then a provider's
   * models). A menu holds a smaller one (30rem), as it sits beside its button. */
  fixedHeight?: string
  /** The sheet's or menu's width; a drawer is a third of the viewport whatever this is. */
  size?: PopupSize
  children: ReactNode
  /** `false` focuses the pop-up itself, so a search field doesn't take focus (and the keyboard) on open. */
  initialFocus?: boolean
}) {
  const popup = useRef<HTMLDivElement>(null)
  const headerSeen = useRef(false)
  const markHeaderSeen = useCallback(() => {
    headerSeen.current = true
  }, [])
  const focus = initialFocus === false ? popup : undefined
  const form = usePopupForm()
  const anchor = useContext(Anchor)
  // Every pop-up renders a header. Only an open one can be missing it: its children mount then, and
  // the header reports through the context below. The check waits a frame, since Base UI puts the
  // popup in the document after the commit that opens it, and clears the flag while it's closed so a
  // later open is checked afresh.
  useEffect(() => {
    if (!import.meta.env.DEV || !children) return
    const frame = requestAnimationFrame(() => {
      if (!popup.current?.isConnected) {
        headerSeen.current = false
        return
      }
      if (!headerSeen.current) console.error("Every PopupContent must render a PopupHeader")
    })
    return () => cancelAnimationFrame(frame)
  })
  if (form === "menu")
    return (
      <HeaderSeen.Provider value={markHeaderSeen}>
        <Popover.Portal>
          <Popover.Positioner
            className="isolate z-50"
            anchor={anchor}
            side="top"
            align="start"
            sideOffset={8}
            collisionPadding={16}
          >
            <Popover.Popup
              ref={popup}
              initialFocus={focus}
              className={cn(
                "flex max-h-[min(36rem,var(--available-height))] max-w-(--available-width) origin-(--transform-origin) flex-col overflow-hidden rounded-2xl bg-popover pb-3 text-sm text-popover-foreground shadow-2xl ring-1 ring-foreground/5 transition-[opacity,scale] duration-150 outline-none data-ending-style:scale-95 data-ending-style:opacity-0 data-starting-style:scale-95 data-starting-style:opacity-0 motion-reduce:transition-none dark:ring-foreground/10",
                MENU_SIZE[size],
                fixedHeight && "h-[min(30rem,var(--available-height))]",
                className,
                // A menu never runs past the room the screen has beside its button, whatever height
                // the content asks for.
                "max-h-[min(36rem,var(--available-height))]",
              )}
            >
              <Scroll>{children}</Scroll>
            </Popover.Popup>
          </Popover.Positioner>
        </Popover.Portal>
      </HeaderSeen.Provider>
    )
  if (form === "drawer")
    return (
      <HeaderSeen.Provider value={markHeaderSeen}>
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
                "relative flex h-full w-[clamp(calc(var(--spacing)*103),33.33vw,calc(var(--spacing)*103*4/3))] max-w-[calc(100vw-3.5rem)] flex-col overflow-hidden rounded-l-2xl bg-popover pb-6 text-sm text-popover-foreground shadow-lg outline-none",
                "[transform:translateX(var(--drawer-swipe-movement-x))] transition-transform duration-300 ease-[cubic-bezier(0.2,0,0,1)] data-ending-style:[transform:translateX(100%)] data-ending-style:duration-[calc(var(--drawer-swipe-strength)*300ms)] data-starting-style:[transform:translateX(100%)] data-swiping:duration-0 data-swiping:select-none motion-reduce:duration-0",
                className,
                // A drawer is always the full height of the screen, whatever a sheet's height was.
                "h-full max-h-none",
              )}
            >
              <Drawer.Content className="flex min-h-0 flex-1 flex-col">
                <Scroll>{children}</Scroll>
              </Drawer.Content>
            </Drawer.Popup>
          </Drawer.Viewport>
        </Drawer.Portal>
      </HeaderSeen.Provider>
    )
  return (
    <HeaderSeen.Provider value={markHeaderSeen}>
      <Drawer.Portal>
        <Drawer.Backdrop
          // Base UI renders a nested drawer's backdrop only when forced, and without it a sheet
          // stacked on another has nothing separating it from the sheet behind: both sit at full
          // brightness and read as one surface. The child's scrim covers the parent sheet, so the
          // stack reads as layers, and a press outside the child still dismisses only the child.
          forceRender
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
              "group/popup relative flex max-h-[85dvh] w-full max-w-[640px] flex-col overflow-hidden rounded-t-[28px] bg-popover pb-[max(1.5rem,env(safe-area-inset-bottom))] text-sm text-popover-foreground shadow-lg outline-none",
              SHEET_SIZE[size],
              fixedHeight,
              // A sheet opened on top of this one stacks on it: this one lifts so a peek shows above
              // the child, its content and handle fading out, and the child's own scrim dims this
              // sheet so the stack reads as layers. Base UI sets the nested count, both heights and
              // the child's swipe progress on the popup, and the lift keeps the peek constant
              // whatever either sheet's height is, unwinding with the child's swipe.
              "[transform:translateY(calc(var(--drawer-swipe-movement-y)-var(--stack-peek-offset)-var(--stack-lift)))] transition-[transform,height] duration-300 ease-[cubic-bezier(0.2,0,0,1)] [--peek:1.75rem] [--stack-front:var(--drawer-frontmost-height,0px)] [--stack-lift:calc(var(--stack-front)-var(--stack-own))] [--stack-own:var(--drawer-height,var(--drawer-frontmost-height,0px))] [--stack-peek-offset:max(0px,calc((var(--nested-drawers)-var(--stack-progress))*var(--peek)))] [--stack-progress:clamp(0,var(--drawer-swipe-progress),1)] data-ending-style:[transform:translateY(100%)] data-ending-style:duration-[calc(var(--drawer-swipe-strength)*300ms)] data-nested-drawer-open:h-[var(--drawer-height)] data-nested-drawer-swiping:duration-0 data-starting-style:[transform:translateY(100%)] data-swiping:duration-0 data-swiping:select-none motion-reduce:duration-0",
              className,
            )}
          >
            <Drawer.Close
              aria-label="Close"
              className="mx-auto flex h-12 w-16 shrink-0 cursor-grab touch-none items-center justify-center transition-opacity duration-200 outline-none group-data-nested-drawer-open/popup:opacity-0 group-data-nested-drawer-swiping/popup:opacity-100 focus-visible:[&>span]:bg-ring"
            >
              <span className="h-1 w-8 rounded-full bg-muted-foreground/60" />
            </Drawer.Close>
            <Drawer.Content className="flex min-h-0 flex-1 flex-col transition-opacity duration-300 group-data-nested-drawer-open/popup:opacity-0 group-data-nested-drawer-swiping/popup:opacity-100">
              <Scroll>{children}</Scroll>
            </Drawer.Content>
          </Drawer.Popup>
        </Drawer.Viewport>
      </Drawer.Portal>
    </HeaderSeen.Provider>
  )
}

/**
 * A focused, full-screen pop-up for something that shouldn't be dismissed by accident (a live
 * recording): it covers the app on every screen size, has no drag handle or scrim to dismiss it, and
 * leaves the way out to its content, which gets Escape and Android's back through `onOpenChange`.
 */
export function FullscreenPopup({
  open,
  onOpenChange,
  className,
  children,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  className?: string
  children: ReactNode
}) {
  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Popup
          className={cn(
            "fixed inset-0 z-50 flex flex-col bg-background text-foreground transition duration-200 outline-none data-ending-style:opacity-0 data-starting-style:scale-[0.98] data-starting-style:opacity-0 motion-reduce:transition-none",
            className,
          )}
        >
          {children}
        </Dialog.Popup>
      </Dialog.Portal>
    </Dialog.Root>
  )
}

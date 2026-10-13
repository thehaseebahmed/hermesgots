import {
  createContext,
  useContext,
  useEffect,
  useRef,
  useState,
  type ComponentProps,
  type CSSProperties,
  type ReactNode,
} from "react"
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
 * tapping the scrim, Escape, or Android's back button (`handleBackButton`).
 *
 * On phones the sheet is expandable, Material 3 style: two snap points (85dvh and full screen), so
 * swiping up past the content's scroll end grows it to full screen — corners square off and the
 * scrim fades out there — and swiping down collapses it back before a further swipe dismisses it.
 * Sheets whose content is shorter than the screen have a single snap point and keep the plain
 * swipe-to-dismiss behavior. The popup is always full height and `--drawer-snap-point-offset` holds
 * it down, so the collapsed look is the offset and expanding is the offset going to zero.
 *
 * A pop-up you read beside the chat rather than act in (`side`: tool details, an agent's transcript)
 * is a modal side sheet from 1280px instead, Material's place for supporting content: full height on
 * the right, swiped off to the right.
 */
const SNAP_COLLAPSED = 0.85
const SNAP_POINTS = [SNAP_COLLAPSED, 1]

export function Popup({ side, ...props }: ComponentProps<typeof Drawer.Root> & { side?: boolean }) {
  const wide = useWide()
  const sideSheet = useXLarge() && Boolean(side)
  const [snapPoint, setSnapPoint] =
    useState<ComponentProps<typeof Drawer.Root>["snapPoint"]>(SNAP_COLLAPSED)
  return (
    <SideSheet.Provider value={sideSheet}>
      <Expanded.Provider value={!wide && snapPoint === 1}>
        <SetSnapPoint.Provider value={setSnapPoint}>
          <Drawer.Root
            swipeDirection={sideSheet ? "right" : "down"}
            snapPoints={wide ? undefined : SNAP_POINTS}
            snapPoint={wide ? undefined : snapPoint}
            onSnapPointChange={wide ? undefined : setSnapPoint}
            snapToSequentialPoints={!wide}
            {...props}
          />
        </SetSnapPoint.Provider>
      </Expanded.Provider>
    </SideSheet.Provider>
  )
}
export const PopupTitle = SheetTitle
export const PopupDescription = SheetDescription

const InSheet = createContext(false)
const SideSheet = createContext(false)
const Expanded = createContext(false)
const SetSnapPoint = createContext<(snap: ComponentProps<typeof Drawer.Root>["snapPoint"]) => void>(
  () => {},
)

/** The innermost scrollable ancestor between `from` and the popup, the way Base UI finds it. */
function findScrollable(from: Element, stop: Element): HTMLElement | null {
  let node: Element | null = from
  while (node && node !== stop) {
    const overflowY = getComputedStyle(node).overflowY
    if (
      (overflowY === "auto" || overflowY === "scroll") &&
      node.scrollHeight > node.clientHeight + 1
    ) {
      return node as HTMLElement
    }
    node = node.parentElement
  }
  return null
}

type ChainGesture = {
  scroll: HTMLElement | null
  offset: number
  lastY: number
  lastT: number
  vy: number
  claimY: number
  claimed: boolean
}

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

export function PopupContent({
  className,
  children,
  initialFocus,
}: {
  className?: string
  children: ReactNode
  /** `false` focuses the pop-up itself, so a search field doesn't take focus (and the keyboard) on open. */
  initialFocus?: boolean
}) {
  const popup = useRef<HTMLDivElement>(null)
  const focus = initialFocus === false ? popup : undefined
  const wide = useWide()
  const side = useContext(SideSheet)
  const expanded = useContext(Expanded)
  const setSnapPoint = useContext(SetSnapPoint)
  // Base UI marks a sheet expanded at its top snap point even when that point resolves to the
  // sheet's own height — a sheet shorter than 85dvh has both snap points at the same offset, so an
  // up-drag advances it to the "expanded" index without the sheet ever reaching full screen. The
  // full-screen look (square corners, no scrim, flush behind a child) follows the measured
  // geometry instead: it only applies to a sheet at its top snap point that is tall enough for
  // full screen to mean anything, the same height test the chaining gesture uses.
  const [fullScreen, setFullScreen] = useState(false)
  useEffect(() => {
    if (wide || side) return
    const el = popup.current
    if (!el) return
    const measure = () => {
      // The popup is as tall as its content allows, up to 100dvh; a sheet shorter than that sits
      // at the top snap point without ever being full screen (both snap points share an offset),
      // so only a sheet that actually fills the viewport gets the full-screen look.
      const full = expanded && el.getBoundingClientRect().height >= window.innerHeight - 2
      setFullScreen(full)
      el.toggleAttribute("data-full", full)
    }
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(el)
    window.addEventListener("resize", measure)
    return () => {
      observer.disconnect()
      window.removeEventListener("resize", measure)
    }
  }, [wide, side, expanded])

  // Scroll-to-expand chaining. Base UI's drawer only claims a content drag that moves toward
  // dismiss, so an upward drag at the content's scroll top is yielded to the scroller and the
  // sheet never grows. Claim it here — before Base UI's own document-capture listener runs — and
  // drive the sheet through the same vars Base UI uses, settling on release. A downward reversal
  // hands the gesture straight back to Base UI, which then collapses or dismisses as usual.
  useEffect(() => {
    if (wide || side) return
    // The popup's DOM sits in a portal that only mounts while open, so the element is resolved
    // when the gesture starts, not here (this effect runs once, while the sheet is still closed).
    let gesture: ChainGesture | null = null
    const release = (el: HTMLElement) => {
      el.style.removeProperty("--drawer-swipe-movement-y")
      el.removeAttribute("data-swiping")
    }
    const onStart = (e: TouchEvent) => {
      gesture = null
      const el = popup.current
      if (!el || e.touches.length !== 1) return
      const target = e.target
      if (!(target instanceof Element) || !el.contains(target)) return
      // Skip interactive targets and an active selection, the way Base UI's own swipe does.
      if (target.closest("button,a,input,select,textarea,label,[role=button]")) return
      const selection = document.getSelection()
      if (selection && !selection.isCollapsed) return
      const offset =
        parseFloat(getComputedStyle(el).getPropertyValue("--drawer-snap-point-offset")) || 0
      if (offset <= 0) return
      gesture = {
        scroll: findScrollable(target, el),
        offset,
        lastY: e.touches[0].clientY,
        lastT: e.timeStamp,
        vy: 0,
        claimY: 0,
        claimed: false,
      }
    }
    const onMove = (e: TouchEvent) => {
      if (!gesture || e.touches.length !== 1) return
      const el = popup.current
      if (!el) return
      const y = e.touches[0].clientY
      const dy = y - gesture.lastY
      const dt = e.timeStamp - gesture.lastT
      gesture.lastY = y
      gesture.lastT = e.timeStamp
      if (dt > 0) gesture.vy = dy / dt
      if (gesture.claimed) {
        if (dy > 0) {
          // The finger reversed: Base UI owns the gesture from here (collapse or dismiss).
          release(el)
          gesture = null
          return
        }
        const moved = y - gesture.claimY
        const next = gesture.offset + moved
        // Same damping Base UI applies past the top edge: square root of the overshoot.
        el.style.setProperty(
          "--drawer-swipe-movement-y",
          `${next >= 0 ? moved : -Math.sqrt(-next) - gesture.offset}px`,
        )
        e.preventDefault()
        e.stopPropagation()
        return
      }
      if (dy >= 0) return // down drags are Base UI's, from the content's top edge
      if (!gesture.scroll) return // chrome outside the scroller: Base UI swipes it itself
      if (gesture.scroll.scrollTop > 0.5) {
        // Content still scrolls: let it, and keep Base UI's React path from claiming an up-drag
        // at the content's end edge in parallel with the native scroll.
        e.stopPropagation()
        return
      }
      gesture.claimed = true
      gesture.claimY = y
      el.setAttribute("data-swiping", "")
      el.style.setProperty("--drawer-swipe-movement-y", "0px")
      e.preventDefault()
      e.stopPropagation()
    }
    const onEnd = () => {
      if (!gesture) return
      if (gesture.claimed && popup.current) {
        const up = gesture.claimY - gesture.lastY
        release(popup.current)
        if (up >= gesture.offset * 0.5 || (up > 12 && gesture.vy <= -0.5)) setSnapPoint(1)
      }
      gesture = null
    }
    window.addEventListener("touchstart", onStart, { capture: true, passive: true })
    window.addEventListener("touchmove", onMove, { capture: true, passive: false })
    window.addEventListener("touchend", onEnd, { capture: true, passive: true })
    window.addEventListener("touchcancel", onEnd, { capture: true, passive: true })
    return () => {
      window.removeEventListener("touchstart", onStart, { capture: true })
      window.removeEventListener("touchmove", onMove, { capture: true })
      window.removeEventListener("touchend", onEnd, { capture: true })
      window.removeEventListener("touchcancel", onEnd, { capture: true })
    }
  }, [wide, side, setSnapPoint])
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
            {CLOSE}
          </Drawer.Popup>
        </Drawer.Viewport>
      </Drawer.Portal>
    )
  if (!wide)
    return (
      <Drawer.Portal>
        <Drawer.Backdrop
          // Base UI renders a nested drawer's backdrop only when forced, and without it a sheet
          // stacked on another has nothing separating it from the sheet behind: both sit at full
          // brightness and read as one surface. The child's scrim covers the parent sheet, so the
          // stack reads as layers, and a press outside the child still dismisses only the child.
          forceRender
          className={cn(
            SCRIM,
            // With snap points Base UI writes the snap progress (1 = collapsed, 0 = expanded)
            // to --drawer-swipe-progress in the settled state, so the scrim rides on our own
            // settled-state var instead and fades over the 300ms settle.
            "opacity-[var(--sheet-scrim,1)] duration-300 data-ending-style:duration-[calc(var(--drawer-swipe-strength)*300ms)] motion-reduce:duration-0",
          )}
          style={{ "--sheet-scrim": fullScreen ? 0 : 1 } as CSSProperties}
        />
        <Drawer.Viewport className="fixed inset-0 z-50 flex items-end justify-center">
          <Drawer.Popup
            ref={popup}
            initialFocus={focus}
            className={cn(
              "group/popup relative flex max-h-[100dvh] w-full max-w-[640px] flex-col overflow-hidden rounded-t-[28px] bg-popover pb-[max(1.5rem,env(safe-area-inset-bottom))] text-sm text-popover-foreground shadow-lg outline-none",
              // A sheet opened on top of this one stacks on it: this one lifts so a peek shows above
              // the child, its content and handle fading out, and the child's own scrim dims this
              // sheet so the stack reads as layers. Base UI sets the nested count, both heights and
              // the child's swipe progress on the popup. While a child is open the child's geometry,
              // not this sheet's own snap offset, places this sheet: its top lands at the child's
              // top, less a 28px peek when this sheet is collapsed. --stack-child-offset pays back
              // the child's own collapsed offset (a child taller than 85dvh is held down that far),
              // so the peek is measured from where the child actually sits; --stack-flush cancels
              // the peek when this sheet is expanded, leaving it flush and hidden behind the child.
              // The peek unwinds with the child's swipe.
              "[transform:translateY(calc(var(--drawer-snap-point-offset)+var(--drawer-swipe-movement-y)+var(--stack-gate)*(var(--stack-own)-var(--stack-front)+var(--stack-child-offset)-var(--stack-peek-offset)+var(--stack-flush)-var(--drawer-snap-point-offset))))] transition-[transform,height] duration-300 ease-[cubic-bezier(0.2,0,0,1)] [--peek:1.75rem] [--stack-child-offset:calc(var(--stack-gate)*max(0px,calc(var(--stack-front)_-_85dvh)))] [--stack-flush:0px] [--stack-front:var(--drawer-frontmost-height,0px)] [--stack-gate:min(1,var(--nested-drawers))] [--stack-own:var(--drawer-height,var(--drawer-frontmost-height,0px))] [--stack-peek-offset:max(0px,calc((var(--nested-drawers)-var(--stack-progress))*var(--peek)))] [--stack-progress:clamp(0,var(--drawer-swipe-progress),1)] data-ending-style:[transform:translateY(100%)] data-ending-style:duration-[calc(var(--drawer-swipe-strength)*300ms)] data-full:rounded-none data-full:[--stack-flush:calc(var(--stack-gate)*var(--peek))] data-nested-drawer-open:h-[var(--drawer-height)] data-nested-drawer-swiping:duration-0 data-starting-style:[transform:translateY(100%)] data-swiping:duration-0 data-swiping:select-none motion-reduce:duration-0",
              className,
            )}
          >
            <div
              aria-hidden
              className="mx-auto flex h-12 w-16 shrink-0 cursor-grab touch-none items-center justify-center transition-opacity duration-200 group-data-nested-drawer-open/popup:opacity-0 group-data-nested-drawer-swiping/popup:opacity-100"
            >
              <span className="h-1 w-8 rounded-full bg-muted-foreground/60" />
            </div>
            <InSheet.Provider value>
              <Drawer.Content className="flex min-h-0 flex-1 flex-col transition-opacity duration-300 group-data-nested-drawer-open/popup:opacity-0 group-data-nested-drawer-swiping/popup:opacity-100">
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
        {CLOSE}
      </Dialog.Popup>
    </Dialog.Portal>
  )
}

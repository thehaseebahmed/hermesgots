import { useEffect, useLayoutEffect, useRef, useState } from "react"
import {
  CornerDownRightIcon,
  KeyboardIcon,
  ListPlusIcon,
  MessageSquarePlusIcon,
  PlusIcon,
  SettingsIcon,
  SparklesIcon,
} from "lucide-react"

import { SkillRow } from "@/components/skill-row"
import { Spinner } from "@/components/ui/spinner"
import { optionId, type SlashItem } from "@/lib/slash"
import type { SkillsState } from "@/lib/skills"

const COMMAND_ICONS = {
  new: PlusIcon,
  thread: MessageSquarePlusIcon,
  settings: SettingsIcon,
  cheatsheet: KeyboardIcon,
  steer: CornerDownRightIcon,
  queue: ListPlusIcon,
}

/** The list's tallest, whatever the screen: the room above the composer caps it below this. */
const MAX_ROOM = 288
/** The least it shrinks to, under three rows, before it gives way to scrolling instead. */
const MIN_ROOM = 132
/** Kept clear above the list, so its first row never sits against the top of the screen. */
const CLEARANCE = 16
/** No more of the screen than this: on a phone with the keyboard up, four rows scroll instead. */
const SCREEN_SHARE = 0.45

export function SlashMenu({
  id,
  items,
  active,
  status,
  onPick,
  onActive,
}: {
  id: string
  items: SlashItem[]
  active: number
  status: SkillsState["status"]
  onPick: (item: SlashItem) => void
  onActive: (index: number) => void
}) {
  const box = useRef<HTMLDivElement>(null)
  const [room, setRoom] = useState(MAX_ROOM)
  // The menu hangs off the composer's top edge, so its lower edge is fixed: what it may be tall is
  // the room above it, and a share of what's on screen — a phone with the keyboard up has little of
  // either, and the list has to give way and scroll rather than run off the top of the screen.
  useLayoutEffect(() => {
    const measure = () => {
      const bottom = box.current?.getBoundingClientRect().bottom
      if (bottom === undefined) return
      // The keyboard isn't part of the layout viewport, so what's visible is the visual one. The
      // floor only lifts the list up to the room there is: it never wins over the measurement, or
      // the first rows would sit above the screen with nothing able to scroll them back.
      const viewport = window.visualViewport
      const visible = viewport?.height ?? window.innerHeight
      const above = bottom - (viewport?.offsetTop ?? 0) - CLEARANCE
      const cap = Math.min(above, visible * SCREEN_SHARE, MAX_ROOM)
      setRoom(Math.max(cap, Math.min(MIN_ROOM, above)))
    }
    measure()
    // The composer grows upward with what it carries (attachment tiles, wrapped text), which moves
    // the room; so does the keyboard, which only the visual viewport hears about. A viewport that
    // moves fires those per frame at most, so the room is read on the frame: one rect a frame while
    // a phone's keyboard or a scroll is moving, however many events arrive inside it.
    let frame = 0
    const soon = () => {
      if (frame) return
      frame = requestAnimationFrame(() => {
        frame = 0
        measure()
      })
    }
    const observer = new ResizeObserver(measure)
    if (box.current?.parentElement) observer.observe(box.current.parentElement)
    window.addEventListener("resize", soon)
    window.visualViewport?.addEventListener("resize", soon)
    window.visualViewport?.addEventListener("scroll", soon)
    return () => {
      cancelAnimationFrame(frame)
      observer.disconnect()
      window.removeEventListener("resize", soon)
      window.visualViewport?.removeEventListener("resize", soon)
      window.visualViewport?.removeEventListener("scroll", soon)
    }
  }, [])

  useEffect(() => {
    document.getElementById(optionId(id, active))?.scrollIntoView({ block: "nearest" })
  }, [id, active])

  return (
    <div
      ref={box}
      className="absolute inset-x-0 bottom-full mb-2 overflow-hidden rounded-3xl border bg-popover text-popover-foreground shadow-lg shadow-black/5"
    >
      <ul
        id={id}
        role="listbox"
        aria-label="Commands and skills"
        style={{ maxHeight: room }}
        className="overflow-y-auto p-1.5"
      >
        {items.map((item, index) => {
          const Icon = item.kind === "command" ? COMMAND_ICONS[item.name] : SparklesIcon
          return (
            <SkillRow
              key={`${item.kind}:${item.name}`}
              id={optionId(id, index)}
              name={item.name}
              slash
              category={item.kind === "skill" ? item.category : undefined}
              description={item.kind === "skill" ? item.description : undefined}
              icon={Icon}
              selected={index === active}
              active={index === active}
              onActive={() => index !== active && onActive(index)}
              onPick={() => onPick(item)}
            />
          )
        })}
      </ul>
      {/* A bot whose host can't list skills shows the commands alone; silently, as a missing feature. */}
      {status === "loading" && (
        <div className="flex items-center gap-2 border-t px-4 py-2.5 text-xs text-muted-foreground">
          <Spinner className="size-3.5" /> Loading skills…
        </div>
      )}
    </div>
  )
}

import { useEffect, useLayoutEffect, useRef, useState } from "react"
import {
  CornerDownRightIcon,
  ListPlusIcon,
  PlusIcon,
  SettingsIcon,
  SparklesIcon,
  TargetIcon,
} from "lucide-react"

import { Badge } from "@/components/ui/badge"
import { Spinner } from "@/components/ui/spinner"
import { optionId, type SlashItem } from "@/lib/slash"
import type { SkillsState } from "@/lib/skills"
import { cn } from "@/lib/utils"

const COMMAND_ICONS = {
  new: PlusIcon,
  goal: TargetIcon,
  settings: SettingsIcon,
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
      // The keyboard isn't part of the layout viewport, so what's visible is the visual one.
      const viewport = window.visualViewport
      const visible = viewport?.height ?? window.innerHeight
      const above = bottom - (viewport?.offsetTop ?? 0) - CLEARANCE
      setRoom(Math.min(MAX_ROOM, Math.max(Math.min(above, visible * SCREEN_SHARE), MIN_ROOM)))
    }
    measure()
    // The composer grows upward with what it carries (attachment tiles, wrapped text), which moves
    // the room; so does the keyboard, which only the visual viewport hears about.
    const observer = new ResizeObserver(measure)
    if (box.current?.parentElement) observer.observe(box.current.parentElement)
    window.addEventListener("resize", measure)
    window.visualViewport?.addEventListener("resize", measure)
    window.visualViewport?.addEventListener("scroll", measure)
    return () => {
      observer.disconnect()
      window.removeEventListener("resize", measure)
      window.visualViewport?.removeEventListener("resize", measure)
      window.visualViewport?.removeEventListener("scroll", measure)
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
            <li
              key={`${item.kind}:${item.name}`}
              id={optionId(id, index)}
              role="option"
              aria-selected={index === active}
              // Keep focus (and the keyboard) on the textarea.
              onMouseDown={(event) => event.preventDefault()}
              onMouseMove={() => index !== active && onActive(index)}
              onClick={() => onPick(item)}
              className={cn(
                "grid min-h-11 cursor-pointer grid-cols-[auto_1fr_auto] content-center items-center gap-x-3 rounded-2xl px-3 py-2",
                index === active && "bg-accent text-accent-foreground",
              )}
            >
              {/* The icon rides the title's line, so a description hangs under the title, not the icon. */}
              <span className="row-start-1 flex h-5 items-center">
                <Icon className="size-4 text-muted-foreground" />
              </span>
              <div className="row-start-1 min-w-0 truncate font-mono text-sm">/{item.name}</div>
              {item.kind === "skill" && item.category && (
                <Badge variant="secondary" className="row-start-1 max-w-28">
                  <span className="truncate">{item.category}</span>
                </Badge>
              )}
              {item.description && (
                <div className="col-start-2 min-w-0 truncate text-xs text-muted-foreground">
                  {item.description}
                </div>
              )}
            </li>
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

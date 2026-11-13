/**
 * The picker a canvas's mark is chosen from (issue #1065): lucide's icons and the phone's emojis, a
 * palette colour for an icon, and a search over both. It opens as a floating menu beside the row it
 * came from on a wide screen and as a sheet under a thumb on a phone, which is the app's own rule for
 * every pop-up (`popup.tsx`).
 *
 * A pick is the record's, not this device's: it posts the mark to the host, the host's answer folds
 * into the store, and the sidebar row beside the sheet redraws from it.
 */
import { useEffect, useMemo, useState, type ReactNode, type RefObject } from "react"
import { FrameIcon } from "lucide-react"

import { Popup, PopupContent, PopupHeader, PopupTitle } from "@/components/popup"
import { PickGroup, PickRow } from "@/components/pick-row"
import { SearchField } from "@/components/search-field"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { Spinner } from "@/components/ui/spinner"
import type { Canvas, CanvasChanges } from "@/lib/canvases"
import { MARK_EMOJIS } from "@/lib/canvas-emojis"
import { useMarkIcons } from "@/lib/canvas-mark-icons"
import {
  MARK_TINTS,
  TINT_FILL,
  TINT_INK,
  markMatches,
  readMark,
  readTint,
  type MarkTint,
} from "@/lib/canvas-marks"
import { cn } from "@/lib/utils"

/**
 * How many icons a grid draws at once. Lucide carries near two thousand, and a pop-up that drew them
 * all would be a scroll nothing reads: the search is the way through the set, and what it still does
 * not fit says how many wait behind it.
 */
const LISTED = 160

function Cell({
  selected,
  label,
  disabled,
  onPick,
  children,
}: {
  selected: boolean
  label: string
  disabled?: boolean
  onPick: () => void
  children: ReactNode
}) {
  return (
    <button
      type="button"
      aria-label={label}
      aria-pressed={selected}
      title={label}
      disabled={disabled}
      onClick={onPick}
      className={cn(
        "flex aspect-square items-center justify-center rounded-xl transition-colors outline-none focus-visible:ring-2 focus-visible:ring-ring/50 disabled:opacity-50",
        selected ? "bg-muted ring-1 ring-foreground/15" : "hover:bg-muted/60",
      )}
    >
      {children}
    </button>
  )
}

/**
 * The colour an icon's mark takes: none — the row's own muted ink — and then the palette's names.
 * A colour is a change to the mark already chosen, so it is written the moment it is tapped; with no
 * icon chosen yet it is the colour the next pick will take.
 */
function Tints({
  value,
  disabled,
  onPick,
}: {
  value?: MarkTint
  disabled?: boolean
  onPick: (tint: MarkTint | undefined) => void
}) {
  const swatch = (tint: MarkTint | undefined, fill: string, label: string) => (
    <button
      key={label}
      type="button"
      aria-label={label}
      aria-pressed={value === tint}
      disabled={disabled}
      onClick={() => onPick(tint)}
      className="flex size-9 shrink-0 items-center justify-center rounded-full outline-none focus-visible:ring-2 focus-visible:ring-ring/50 disabled:opacity-50"
    >
      <span
        className={cn(
          "size-6 rounded-full transition-shadow",
          fill,
          value === tint && "ring-2 ring-foreground/50 ring-offset-2 ring-offset-popover",
        )}
      />
    </button>
  )
  return (
    <div data-canvas-mark-tints className="flex items-center gap-1 overflow-x-auto px-2 pb-1">
      {swatch(undefined, "bg-muted-foreground", "No colour")}
      {MARK_TINTS.map((name) => swatch(name, TINT_FILL[name], name))}
    </div>
  )
}

export function CanvasMarkPicker({
  open,
  onOpenChange,
  anchor,
  canvas,
  onUpdate,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  /** The row it opened from: a menu beside it from 1024px, a sheet under it below that. */
  anchor: RefObject<HTMLElement | null>
  canvas: Canvas | undefined
  onUpdate: (changes: CanvasChanges) => Promise<void>
}) {
  const icons = useMarkIcons()
  const [tab, setTab] = useState("icons")
  const [query, setQuery] = useState("")
  const [saving, setSaving] = useState(false)
  // The colour the grid draws in and the next icon takes: the record's until a tap moves it, since a
  // colour chosen before an icon is the colour that icon will wear.
  const [tint, setTint] = useState<MarkTint | undefined>(readTint(canvas?.markTint))
  const chosen = canvas?.mark ?? ""

  // Opened again, the picker stands on the tab the canvas's mark already lives in, with the colour it
  // wears, so the answer it is about to change is the one on screen.
  useEffect(() => {
    if (!open) return
    setTab(readMark(canvas?.mark)?.kind === "emoji" ? "emojis" : "icons")
    setTint(readTint(canvas?.markTint))
    setQuery("")
  }, [open, canvas?.mark, canvas?.markTint])

  /** Writes the change the picker means, and answers whether it landed. */
  const save = async (changes: CanvasChanges) => {
    if (saving) return false
    setSaving(true)
    try {
      await onUpdate(changes)
      return true
    } catch {
      // Said where it was read, with the host's own words; the grids keep the record it holds.
      return false
    } finally {
      setSaving(false)
    }
  }

  /** A pick is the answer to what the picker was opened for, so the picker closes on the answer. */
  const pick = async (changes: CanvasChanges) => {
    if (await save(changes)) onOpenChange(false)
  }

  /** A colour is a change to the icon already chosen, so it is written the moment it is tapped. */
  const chooseTint = (next: MarkTint | undefined) => {
    setTint(next)
    if (readMark(canvas?.mark)?.kind === "icon") void save({ mark_tint: next ?? "" })
  }

  const grid = useMemo(() => {
    if (!icons) return { listed: [], more: 0 }
    const matched = [...icons.entries()].filter(([, icon]) => markMatches(icon.words, query))
    return { listed: matched.slice(0, LISTED), more: Math.max(0, matched.length - LISTED) }
  }, [icons, query])

  const emojis = useMemo(
    () => MARK_EMOJIS.filter((emoji) => markMatches(emoji.words, query)),
    [query],
  )

  return (
    <Popup open={open} onOpenChange={onOpenChange} anchor={anchor}>
      <PopupContent size="xl" dataSlot="canvas-mark-picker">
        <PopupHeader className="pb-0">
          <PopupTitle>Mark</PopupTitle>
        </PopupHeader>
        <Tabs
          value={tab}
          onValueChange={(next) => {
            setTab(next)
            setQuery("")
          }}
          className="min-h-0 flex-1 gap-0"
        >
          <TabsList className="px-4">
            <TabsTrigger value="icons" className="flex-none">
              Icons
            </TabsTrigger>
            <TabsTrigger value="emojis" className="flex-none">
              Emojis
            </TabsTrigger>
          </TabsList>
          <div className="flex flex-col gap-2 px-4 pt-3">
            <SearchField
              value={query}
              onChange={setQuery}
              label={tab === "icons" ? "Search icons" : "Search emojis"}
            />
            {tab === "icons" && (
              <Tints value={tint} disabled={saving || !canvas} onPick={chooseTint} />
            )}
          </div>

          <TabsContent value="icons" className="min-h-0 overflow-y-auto px-2 pt-2">
            {!icons ? (
              <div className="flex justify-center py-8">
                <Spinner />
              </div>
            ) : (
              <>
                <div data-canvas-mark-grid="icons" className="grid grid-cols-8 gap-1 px-2">
                  {grid.listed.map(([name, icon]) => (
                    <Cell
                      key={name}
                      label={icon.words}
                      selected={chosen === name}
                      disabled={saving || !canvas}
                      onPick={() => void pick({ mark: name, mark_tint: tint ?? "" })}
                    >
                      <icon.Icon
                        className={cn("size-5", tint ? TINT_INK[tint] : "text-muted-foreground")}
                      />
                    </Cell>
                  ))}
                </div>
                {grid.listed.length === 0 && (
                  <p className="px-2 py-8 text-center text-sm text-muted-foreground">
                    No icon matches.
                  </p>
                )}
                {grid.more > 0 && (
                  <p className="px-2 py-3 text-center text-xs text-muted-foreground">
                    {grid.more} more — search to narrow them.
                  </p>
                )}
              </>
            )}
          </TabsContent>

          <TabsContent value="emojis" className="min-h-0 overflow-y-auto px-2 pt-2">
            <div data-canvas-mark-grid="emojis" className="grid grid-cols-8 gap-1 px-2">
              {emojis.map((emoji) => (
                <Cell
                  key={emoji.glyph}
                  label={emoji.words}
                  selected={chosen === emoji.glyph}
                  disabled={saving || !canvas}
                  onPick={() => void pick({ mark: emoji.glyph })}
                >
                  <span className="text-xl leading-none">{emoji.glyph}</span>
                </Cell>
              ))}
            </div>
            {emojis.length === 0 && (
              <p className="px-2 py-8 text-center text-sm text-muted-foreground">
                No emoji matches.
              </p>
            )}
          </TabsContent>

          {/* The way back: a canvas nobody has marked draws the app's own frame, as every canvas did
              before a mark could be chosen. Under the grid's own scroll rather than inside it, so
              clearing a mark is never a scroll through every icon to find. */}
          <div className="border-t px-4 py-2">
            <PickGroup mode="choose" surface="plate" label="No mark">
              <PickRow
                leading={<FrameIcon className="size-5 text-muted-foreground" />}
                title="Use the app's own mark"
                selected={!chosen}
                disabled={saving || !canvas}
                onPick={() => void pick({ mark: "" })}
              />
            </PickGroup>
          </div>
        </Tabs>
      </PopupContent>
    </Popup>
  )
}

/**
 * The picker a canvas's mark is chosen from (issue #1065): lucide's icons and the phone's emojis,
 * one search over both. It is the centred dialog a tablet or a laptop opens and the bottom sheet a
 * phone does (`useWide`), with the tabs the Outputs sheet draws and no more box than the model
 * selector's.
 *
 * A pick is the record's, not this device's: it posts the mark to the host, the host's answer folds
 * into the store, and the row it was opened from redraws from it.
 */
import { useMemo, useState, type ReactNode } from "react"

import { Popup, PopupContent, PopupHeader, PopupTitle } from "@/components/popup"
import { SearchField } from "@/components/search-field"
import { Button } from "@/components/ui/button"
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Spinner } from "@/components/ui/spinner"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import type { Canvas, CanvasChanges } from "@/lib/canvases"
import { MARK_EMOJIS } from "@/lib/canvas-emojis"
import { useMarkIcons } from "@/lib/canvas-mark-icons"
import { markMatches, readMark } from "@/lib/canvas-marks"
import { useWide } from "@/lib/media"
import { cn } from "@/lib/utils"

/**
 * How many icons a grid draws at once. Lucide carries near two thousand, and a card that drew them
 * all would be a scroll nothing reads: the search is the way through the set, and what still does not
 * fit says how many wait behind it.
 */
const LISTED = 160

/** The picker's own box: the model selector's height, and no taller than the screen allows. */
const PICKER = "h-[min(30rem,85dvh)]"

/** One mark in the grid: the icon or the glyph, and the pale disc that says it is the one chosen. */
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
        "flex aspect-square items-center justify-center rounded-xl outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring/50 disabled:opacity-50",
        selected ? "bg-muted ring-1 ring-foreground/15" : "hover:bg-muted/60",
      )}
    >
      {children}
    </button>
  )
}

/**
 * The picker itself, inside whichever card opened it. It is mounted only while the picker is open, so
 * it opens on the tab the canvas's mark already lives in and on an empty field every time.
 */
function MarkPicker({
  canvas,
  onUpdate,
  onDone,
}: {
  canvas: Canvas | undefined
  onUpdate: (changes: CanvasChanges) => Promise<void>
  onDone: () => void
}) {
  const icons = useMarkIcons()
  const chosen = canvas?.mark ?? ""
  const [tab, setTab] = useState(() =>
    readMark(canvas?.mark)?.kind === "emoji" ? "emojis" : "icons",
  )
  const [query, setQuery] = useState("")
  const [saving, setSaving] = useState(false)

  /** Writes the mark the picker means, and answers whether the host took it. */
  const write = async (changes: CanvasChanges) => {
    if (saving || !canvas) return false
    setSaving(true)
    try {
      await onUpdate(changes)
      return true
    } catch {
      // Said where it was read, with the host's own words; the grid keeps the record it holds.
      return false
    } finally {
      setSaving(false)
    }
  }

  /** A pick is the answer to what the picker was opened for, so the picker closes on it. */
  const pick = async (mark: string) => {
    if (await write({ mark })) onDone()
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
    <Tabs
      value={tab}
      onValueChange={(next) => {
        setTab(next)
        setQuery("")
      }}
      className="min-h-0 flex-1 gap-0"
    >
      <div className="px-3 sm:px-4">
        <TabsList>
          <TabsTrigger value="icons">Icons</TabsTrigger>
          <TabsTrigger value="emojis">Emojis</TabsTrigger>
        </TabsList>
      </div>
      <div className="px-4 pt-3">
        <SearchField
          value={query}
          onChange={setQuery}
          label={tab === "icons" ? "Search icons" : "Search emojis"}
        />
      </div>

      <TabsContent value="icons" className="min-h-0 overflow-y-auto px-4 pt-3">
        {!icons ? (
          <div className="flex justify-center py-8">
            <Spinner />
          </div>
        ) : (
          <>
            <div data-canvas-mark-grid="icons" className="grid grid-cols-8 gap-1">
              {grid.listed.map(([name, icon]) => (
                <Cell
                  key={name}
                  label={icon.words}
                  selected={chosen === name}
                  disabled={saving || !canvas}
                  onPick={() => void pick(name)}
                >
                  <icon.Icon className="size-5 text-muted-foreground" />
                </Cell>
              ))}
            </div>
            {grid.listed.length === 0 && (
              <p className="py-8 text-center text-sm text-muted-foreground">No icon matches.</p>
            )}
            {grid.more > 0 && (
              <p className="py-3 text-center text-xs text-muted-foreground">
                {grid.more} more — search to narrow them.
              </p>
            )}
          </>
        )}
      </TabsContent>

      <TabsContent value="emojis" className="min-h-0 overflow-y-auto px-4 pt-3">
        <div data-canvas-mark-grid="emojis" className="grid grid-cols-8 gap-1">
          {emojis.map((emoji) => (
            <Cell
              key={emoji.glyph}
              label={emoji.words}
              selected={chosen === emoji.glyph}
              disabled={saving || !canvas}
              onPick={() => void pick(emoji.glyph)}
            >
              <span className="text-xl leading-none">{emoji.glyph}</span>
            </Cell>
          ))}
        </div>
        {emojis.length === 0 && (
          <p className="py-8 text-center text-sm text-muted-foreground">No emoji matches.</p>
        )}
      </TabsContent>

      {/* The way back: a canvas nobody has marked draws the app's own frame, as every canvas did
          before a mark could be chosen. Under the grid's own scroll rather than inside it. */}
      <div className="border-t px-4 py-3">
        <Button
          type="button"
          variant="outline"
          data-canvas-mark-unset
          className="w-full"
          disabled={saving || !canvas || !chosen}
          onClick={() => void pick("")}
        >
          Use the app's own mark
        </Button>
      </div>
    </Tabs>
  )
}

/** The picker as a wide screen opens it: a dialog, no wider than the model selector. */
export function CanvasMarkPicker({
  open,
  onOpenChange,
  canvas,
  onUpdate,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  canvas: Canvas | undefined
  onUpdate: (changes: CanvasChanges) => Promise<void>
}) {
  const wide = useWide()
  const body = (
    <MarkPicker canvas={canvas} onUpdate={onUpdate} onDone={() => onOpenChange(false)} />
  )
  if (wide)
    return (
      <Dialog open={open} onOpenChange={onOpenChange}>
        <DialogContent
          size="sm"
          data-canvas-mark-picker=""
          className={cn("grid-rows-[auto_minmax(0,1fr)] gap-0 p-0", PICKER)}
        >
          <DialogHeader className="px-4 pt-4">
            <DialogTitle>Mark</DialogTitle>
          </DialogHeader>
          {body}
        </DialogContent>
      </Dialog>
    )
  return (
    <Popup open={open} onOpenChange={onOpenChange}>
      <PopupContent dataSlot="canvas-mark-picker" className={PICKER}>
        <PopupHeader className="pb-0">
          <PopupTitle>Mark</PopupTitle>
        </PopupHeader>
        {body}
      </PopupContent>
    </Popup>
  )
}

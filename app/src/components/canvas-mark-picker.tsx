/**
 * The picker a canvas's face is chosen from (issues #1065, #1074): lucide's icons and the phone's
 * emojis, one search over both, and — on a tab of its own — the picture the Canvas list draws.
 * It opens the way the model selector does — a menu anchored to the button it came from on a laptop
 * and up, a bottom sheet below that — with the tabs the Outputs sheet draws, and it says what it is
 * for in the same words everywhere: Canvas Icon.
 *
 * A pick is the record's, not this device's: it posts the mark — or the picture, which is one inline
 * image the host keeps on the same record — to the host, the host's answer folds into the store, and
 * the row and the tile it was opened for redraw from it.
 */
import { useMemo, useRef, useState, type ReactNode, type RefObject } from "react"

import { Popup, PopupContent, PopupHeader } from "@/components/popup"
import { SearchField } from "@/components/search-field"
import { Button } from "@/components/ui/button"
import { Spinner } from "@/components/ui/spinner"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import type { Canvas, CanvasChanges } from "@/lib/canvases"
import { MARK_EMOJIS } from "@/lib/canvas-emojis"
import { UNREADABLE_PICTURE, inlinePicture } from "@/lib/canvas-image"
import { useMarkIcons } from "@/lib/canvas-mark-icons"
import { markMatches, readMark } from "@/lib/canvas-marks"
import { cn } from "@/lib/utils"

/**
 * How many icons a grid draws at once. Lucide carries near two thousand, and a card that drew them
 * all would be a scroll nothing reads: the search is the way through the set, and what still does not
 * fit says how many wait behind it.
 */
const LISTED = 160

/** The picker's own box: the model selector's, so the two read as one kind of card. */
const PICKER = "h-[min(36rem,85dvh)]"

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
  // A picture is read here, not by the host, so what the device's own decoder says about one is said
  // on the tab that asked rather than where the host's refusals are said.
  const [said, setSaid] = useState<string | null>(null)
  const [reading, setReading] = useState(false)
  const pictureField = useRef<HTMLInputElement>(null)
  const busy = saving || reading

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

  /**
   * A picture the reader chose, read here and posted as the record's `image`. What the file can't be
   * — too big for the host to keep, or no picture at all — is said on the tab that asked for it, and
   * the record the grid draws stays as it was.
   */
  const choose = async (file: File | undefined) => {
    if (!file || busy) return
    setSaid(null)
    setReading(true)
    try {
      const image = await inlinePicture(file)
      if (await write({ image })) onDone()
    } catch (failure) {
      setSaid(failure instanceof Error ? failure.message : UNREADABLE_PICTURE)
    } finally {
      setReading(false)
    }
  }

  /** The picture taken off the record, which is a canvas that goes back to its mark. */
  const clearPicture = async () => {
    if (busy) return
    setSaid(null)
    if (await write({ image: "" })) onDone()
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
          <TabsTrigger value="picture">Picture</TabsTrigger>
        </TabsList>
      </div>
      {/* The search narrows a set of marks; a picture is one place of its own, so it has none. */}
      {tab !== "picture" && (
        <div className="px-4 pt-3">
          <SearchField
            value={query}
            onChange={setQuery}
            label={tab === "icons" ? "Search icons" : "Search emojis"}
          />
        </div>
      )}

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
                  disabled={busy || !canvas}
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
              disabled={busy || !canvas}
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

      {/*
        The picture is the canvas's face in the list, and it wins over the mark wherever both exist:
        it sits on the record as one inline image, so a canvas draws the same one on every device.
      */}
      <TabsContent value="picture" className="min-h-0 overflow-y-auto px-4 pt-3">
        <div className="flex flex-col gap-3">
          <div
            data-canvas-picture={canvas?.image ? "picture" : "none"}
            className="relative mx-auto aspect-[4/3] w-56 overflow-hidden rounded-2xl border bg-muted/40"
          >
            {canvas?.image ? (
              <img src={canvas.image} alt="" className="size-full object-cover" />
            ) : (
              <span className="flex size-full items-center justify-center px-4 text-center text-sm text-muted-foreground">
                No picture yet.
              </span>
            )}
          </div>
          <p className="text-sm text-muted-foreground">
            The Canvas list draws this for the canvas, over any icon. It's kept on the canvas itself,
            so every device draws the same one.
          </p>
          {said && (
            <p data-canvas-picture-said className="text-sm text-destructive-ink">
              {said}
            </p>
          )}
          <Button
            type="button"
            variant="outline"
            data-canvas-picture-choose
            className="w-full"
            disabled={busy || !canvas}
            onClick={() => pictureField.current?.click()}
          >
            {reading ? "Reading it…" : canvas?.image ? "Choose another picture" : "Choose a picture"}
          </Button>
          {canvas?.image && (
            <Button
              type="button"
              variant="ghost"
              data-canvas-picture-unset
              className="w-full"
              disabled={busy || !canvas}
              onClick={() => void clearPicture()}
            >
              Remove picture
            </Button>
          )}
          <input
            ref={pictureField}
            id="canvas-picture"
            type="file"
            accept="image/*"
            className="hidden"
            onChange={(event) => {
              const file = event.target.files?.[0]
              // The field forgets what it was handed, so choosing that same file again is a choice
              // again rather than a change no one hears about.
              event.target.value = ""
              void choose(file)
            }}
          />
        </div>
      </TabsContent>

      {/* The way back: a canvas nobody has marked draws the app's own frame, as every canvas did
          before a mark could be chosen. Under the grid's own scroll rather than inside it. */}
      {tab !== "picture" && (
        <div className="border-t px-4 py-3">
          <Button
            type="button"
            variant="outline"
            data-canvas-mark-unset
            className="w-full"
            disabled={busy || !canvas || !chosen}
            onClick={() => void pick("")}
          >
            Remove Icon
          </Button>
        </div>
      )}
    </Tabs>
  )
}

/**
 * The picker, opened by the button it belongs to: the model selector's own rule (`ModelMenu`), so a
 * laptop draws the card beside that button and a phone draws the sheet under its thumb. The heading
 * is centred in both, since it names the card rather than the list under it.
 */
export function CanvasMarkPicker({
  open,
  onOpenChange,
  anchor,
  canvas,
  onUpdate,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  /** The mark's box in the options: a menu beside it from 1024px, a sheet under it below that. */
  anchor: RefObject<HTMLElement | null>
  canvas: Canvas | undefined
  onUpdate: (changes: CanvasChanges) => Promise<void>
}) {
  return (
    <Popup open={open} onOpenChange={onOpenChange} anchor={anchor}>
      <PopupContent dataSlot="canvas-mark-picker" fixedHeight={PICKER}>
        <PopupHeader className="pb-0">
          <h2 className="cn-font-heading w-full truncate text-center text-base font-medium text-foreground">
            Canvas Icon
          </h2>
        </PopupHeader>
        <MarkPicker canvas={canvas} onUpdate={onUpdate} onDone={() => onOpenChange(false)} />
      </PopupContent>
    </Popup>
  )
}

import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { useLiveQuery } from "dexie-react-hooks"
import {
  ArrowUpIcon,
  EllipsisIcon,
  FrameIcon,
  MenuIcon,
  PencilIcon,
  Undo2Icon,
} from "lucide-react"
import { Link, Navigate, useNavigate, useParams } from "react-router"

import { ChatBody } from "@/chat-next/chat-body"
import { BackButton } from "@/components/back-button"
import {
  CanvasConsentDialog,
  CanvasOptions,
  useCanvasConsent,
} from "@/components/canvas-consent"
import { CanvasPointsProvider, type CanvasPoints } from "@/components/chat/canvas-points"
import { useChatSurface } from "@/components/chat/chat-actions"
import { BotPicker } from "@/components/chat/bot-picker"
import { PreviewerProvider } from "@/components/chat/previewer"
import { UsageSheet, type ContextUsage } from "@/components/chat/usage-sheet"
import { useOpenDrawer } from "@/components/drawer-context"
import { ExperimentalBadge } from "@/components/experimental-badge"
import { ItemGroup } from "@/components/item-list"
import { setBackGuard } from "@/lib/native"
import { useNav } from "@/lib/nav"
import { Button } from "@/components/ui/button"
import {
  InputGroup,
  InputGroupAddon,
  InputGroupButton,
  InputGroupTextarea,
} from "@/components/ui/input-group"
import { Spinner } from "@/components/ui/spinner"
import { attempt } from "@/lib/attempt"
import { awayLine } from "@/lib/away"
import { bridgeHandler, pointWatch } from "@/lib/canvas-bridge"
import { canvasCss, canvasCssKey } from "@/lib/canvas-css"
import { canvasDocument, readScroll, themeTokens, type CanvasMode } from "@/lib/canvas-document"
import { CANVAS_LIBRARIES } from "@/lib/canvas-libraries"
import {
  callCanvasCall,
  canvasData,
  deleteCanvas,
  grantCanvasTool,
  refreshCanvas,
  startCanvas,
  undoCanvas,
  updateCanvas,
  useCanvas,
  useCanvases,
  writeCanvasData,
  type Canvas,
  type CanvasChanges,
} from "@/lib/canvases"
import { db, getActiveProfile, type Profile } from "@/lib/db"
import type { CanvasPoint } from "@/lib/point-marker"
import { hostAnswered, type ProviderUsage } from "@/lib/hermes"
import { useLarge } from "@/lib/media"
import { openExternal } from "@/lib/native"
import { useOnline } from "@/lib/online"
import { useDark } from "@/lib/theme"
import { formatRelative } from "@/lib/format"
import { tell } from "@/lib/tell"
import { useNow } from "@/lib/threads"

/**
 * The two Canvas routes: `/canvas` lists every bot's pages beside the prompt that makes one, and
 * `/canvas/:id` draws one page in a sandboxed frame (ADR 0114).
 */

/** How the tiles are laid out: a phone holds two, a tablet three, a desktop four. */
const TILES = "grid grid-cols-2 gap-3 sm:grid-cols-3 xl:grid-cols-4"

/**
 * A canvas in the list: the picture its bot put on it, or its own mark, over the name and where it
 * stands. A tile rather than a row, since what a reader picks from is a page — the picture is the
 * whole of what tells two canvases apart at a glance.
 */
function CanvasTile({ canvas, now }: { canvas: Canvas; now: number }) {
  const line = canvas.version > 0 ? `Version ${canvas.version}` : "Building it…"
  return (
    <Link
      to={`/canvas/${canvas.id}`}
      data-canvas-tile
      className="group flex min-w-0 flex-col gap-2 rounded-2xl outline-none focus-visible:ring-2 focus-visible:ring-ring/40"
    >
      <div
        data-canvas-tile-image={canvas.image ? "picture" : "mark"}
        className="relative aspect-[4/3] overflow-hidden rounded-2xl border bg-muted/40"
      >
        {canvas.image ? (
          <img src={canvas.image} alt="" className="size-full object-cover" loading="lazy" />
        ) : (
          <span className="flex size-full items-center justify-center text-muted-foreground">
            <FrameIcon className="size-7" aria-hidden />
          </span>
        )}
      </div>
      <div className="min-w-0 px-0.5">
        <p className="truncate text-sm font-medium">{canvas.title}</p>
        <p className="truncate text-xs text-muted-foreground">
          {line}
          {canvas.at ? ` · ${formatRelative(canvas.at, now)}` : ""}
        </p>
      </div>
    </Link>
  )
}

export function CanvasPage() {
  const openDrawer = useOpenDrawer()
  const navigate = useNavigate()
  const { visible, archived, loaded, unsupported } = useCanvases()
  const profile = useLiveQuery(getActiveProfile, [])
  const now = useNow()
  const [prompt, setPrompt] = useState("")
  const [starting, setStarting] = useState(false)
  const blocked = profile ? unsupported[profile.id] : undefined

  const create = async () => {
    if (!profile || !prompt.trim() || starting) return
    setStarting(true)
    let started: Awaited<ReturnType<typeof startCanvas>> | undefined
    await attempt("start the canvas", async () => {
      started = await startCanvas(profile, prompt.trim(), profile.modelChoice)
    })
    setStarting(false)
    if (!started) return
    setPrompt("")
    navigate(`/canvas/${started.id}`)
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-y-auto">
      <header className="sticky top-0 z-10 bg-background/80 px-4 pt-[max(0.75rem,env(safe-area-inset-top))] pb-3 backdrop-blur">
        <div className="mx-auto flex max-w-2xl items-center gap-3">
          <Button
            variant="outline"
            size="icon-lg"
            className="size-11 rounded-full md:hidden"
            onClick={openDrawer}
            aria-label="Open conversations"
          >
            <MenuIcon />
          </Button>
          <h1 className="flex flex-1 items-center gap-2 text-xl font-semibold tracking-tight">
            Canvas
            <ExperimentalBadge />
          </h1>
        </div>
      </header>

      <div className="mx-auto flex w-full max-w-2xl flex-col gap-8 px-4 pt-4 pb-[max(2rem,env(safe-area-inset-bottom))] md:pt-10">
        <section className="flex flex-col gap-3">
          <h2 className="text-center text-2xl font-semibold tracking-tight md:text-3xl">
            What should it be?
          </h2>
          <form
            onSubmit={(event) => {
              event.preventDefault()
              void create()
            }}
            className="flex flex-col gap-3"
          >
            {profile && (
              <div>
                <BotPicker profile={profile} />
              </div>
            )}
            {/* The prompt and its send are one field, as Research asks its own: the button sits in
                the box's corner rather than under it, so the words and the press are one thing. */}
            <InputGroup className="bg-background shadow-lg shadow-black/5 has-[textarea]:rounded-[1.75rem] dark:bg-input/30">
              <InputGroupTextarea
                value={prompt}
                onChange={(event) => setPrompt(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter" && !event.shiftKey) {
                    event.preventDefault()
                    void create()
                  }
                }}
                rows={3}
                placeholder="A tip calculator for a restaurant bill, in the app's own colours"
                aria-label="What the canvas should be"
                className="max-h-48 min-h-20 px-5 pt-4 pb-2 text-base md:text-[15px]"
              />
              <InputGroupAddon align="block-end" className="px-2.5 pt-0 pb-1.5">
                <span className="flex-1" />
                <InputGroupButton
                  type="submit"
                  variant="default"
                  size="icon-sm"
                  className="size-11 rounded-full"
                  disabled={!profile || !prompt.trim() || starting}
                  aria-label="Make it"
                >
                  {starting ? <Spinner /> : <ArrowUpIcon />}
                </InputGroupButton>
              </InputGroupAddon>
            </InputGroup>
            {blocked && <p className="text-sm text-muted-foreground">{blocked}</p>}
          </form>
        </section>

        <section className="flex flex-col gap-4">
          {loaded && visible.length === 0 && archived.length === 0 && !blocked && (
            <p className="py-8 text-center text-sm text-muted-foreground">
              No canvases yet.
            </p>
          )}
          {visible.length > 0 && (
            <ul className={TILES} aria-label="Canvases">
              {visible.map((canvas) => (
                <li key={canvas.id} className="min-w-0">
                  <CanvasTile canvas={canvas} now={now} />
                </li>
              ))}
            </ul>
          )}
          {archived.length > 0 && (
            <ItemGroup
              group={{ key: "archived", label: "Archived", items: archived, folded: true }}
              listClassName={TILES}
            >
              {archived.map((canvas) => (
                <li key={canvas.id} className="min-w-0">
                  <CanvasTile canvas={canvas} now={now} />
                </li>
              ))}
            </ItemGroup>
          )}
        </section>
      </div>
    </div>
  )
}

/**
 * Where each canvas's page was last left, a place per canvas: the preview is unmounted while the
 * reader is on the edit screen, so the position has to outlive the screen that heard it (ADR 0130).
 * Module-level for that reason alone.
 */
const SCROLLS = new Map<string, number>()

/**
 * One canvas, drawn from the version its record points at, with its chat beside it on a wide screen
 * and the header's Edit for the chat's own page on a phone.
 */
export function CanvasView() {
  const { id = "" } = useParams()
  const { up, step } = useNav()
  const navigate = useNavigate()
  useEffect(() => setBackGuard(step("/canvas")), [step])
  const { canvas, missing, loaded, away } = useCanvas(id)
  const online = useOnline()
  // A device with no network can't reach the host either, and is told so in its own words (ADR 0071)
  // rather than being told its bot is down.
  const awayNow = away || !online
  const awayWords = awayLine(awayNow, online)
  const dark = useDark()
  const mode: CanvasMode = dark ? "dark" : "light"
  const html = canvas?.html
  const large = useLarge()
  // How many times the frame has been drawn for this version (a document that left is drawn again),
  // and whether that one redraw was already spent.
  const [escapedFor, setEscapedFor] = useState("")
  const [usageOpen, setUsageOpen] = useState(false)
  // The numbers the usage sheet draws, handed up by the chat it belongs to.
  const [surface, setSurface] = useState<ChatSurfaceUsage | null>(null)
  const [optionsOpen, setOptionsOpen] = useState(false)
  const frame = useRef<HTMLIFrameElement>(null)
  // The page's classes compiled, kept with the version they were compiled for: an answer that lands
  // after the screen has moved to another version is no CSS to draw with, and no CSS at all keeps
  // the frame off the page until there is one.
  const [compiled, setCompiled] = useState<{ key: string; css: string } | null>(null)
  const canvasId = canvas?.id
  const version = canvas?.version
  const cssKey = canvasId && version !== undefined ? canvasCssKey(canvasId, version) : null
  const css = compiled && compiled.key === cssKey ? compiled.css : null
  useEffect(() => {
    if (!canvasId || version === undefined || !html) return
    const key = canvasCssKey(canvasId, version)
    let live = true
    void canvasCss(canvasId, version, html).then(
      (value) => {
        if (live) setCompiled({ key, css: value })
      },
      // A page whose classes couldn't be compiled is still a page: it is drawn with its own
      // `<style>` and the app's tokens, as a canvas was before any of its classes were compiled.
      () => {
        if (live) setCompiled({ key, css: "" })
      },
    )
    return () => {
      live = false
    }
  }, [canvasId, version, html])
  const profile = useLiveQuery(
    () => (canvas ? db.profiles.get(canvas.profileId) : undefined),
    [canvas?.profileId],
  )
  // The document at a position, built once for every draw: the reader's page, and the page drawn
  // again where they left it.
  const documentAt = useCallback(
    (scroll: number) => {
      if (!html || css === null) return null
      try {
        return {
          document: canvasDocument(html, {
            mode,
            tokens: themeTokens(readTheme()),
            css,
            libraries: CANVAS_LIBRARIES,
            scroll,
          }),
        }
      } catch {
        return { error: "This canvas can't be drawn: its document has no head." }
      }
    },
    [html, mode, css],
  )
  const drawn = useMemo(
    // Where this canvas was left, read when the document is built and never per scroll: a scroll is
    // news for the next draw, not a reason to draw again.
    () => documentAt(SCROLLS.get(id) ?? 0),
    [documentAt, id],
  )

  // The page says where it has been scrolled to, and only this screen's own frame is heard: a message
  // from any other window is not the canvas talking.
  useEffect(() => {
    const hear = (event: MessageEvent) => {
      if (event.source !== frame.current?.contentWindow) return
      const at = readScroll(event.data)
      if (at === null) return
      SCROLLS.set(id, at)
    }
    window.addEventListener("message", hear)
    return () => window.removeEventListener("message", hear)
  }, [id])

  // The reader's answer about a tool is kept on the host, and the host's canvas replaces the copy
  // this screen draws. A grant that couldn't be posted answers no — the page's own promise hears the
  // refusal rather than being retried on a permission the host never recorded. A host that answered
  // and refused said why (a version rewritten while the dialog was up no longer declares the tool),
  // and that is the page's answer in the host's own words, said to the reader too; only a host that
  // never landed answers no.
  const grant = async (tool: string, allow: boolean) => {
    try {
      await grantCanvasTool(id, tool, allow)
      return allow
    } catch (failure) {
      if (!hostAnswered(failure)) return false
      tell.error(failure.message)
      throw failure
    }
  }
  const consent = useCanvasConsent(grant)
  // The bridge is registered once per canvas, so the ask is read through a ref: a new ask must not
  // re-register the listener under a running page. The device's copy is read at call time from the
  // store, so a read landing never re-registers it either.
  const askRef = useRef(consent.ask)
  askRef.current = consent.ask

  // Pointing, through the bridge (ADR 0114): the chat's composer arms the page through this, and the
  // element the page answers reaches the composer's chip by the bridge's own listener — so nothing but
  // this screen's frame is heard. The listeners are held for the screen's life rather than a render's,
  // so one press is one arm, and the page is let go only once the last listener has gone.
  const answers = useRef(new Set<(point: CanvasPoint) => void>())
  const tellPage = (watch: boolean) => {
    frame.current?.contentWindow?.postMessage(pointWatch(watch), "*")
  }
  const points = useMemo<CanvasPoints>(
    () => ({
      listen(answer) {
        answers.current.add(answer)
        tellPage(true)
        return () => {
          answers.current.delete(answer)
          if (!answers.current.size) tellPage(false)
        }
      },
      answer(point) {
        for (const answer of [...answers.current]) answer(point)
      },
    }),
    [],
  )
  /**
   * A version or a mode redraws the frame as a whole new document, and one that was never told is not
   * listening: the page says when its own half has run, and an arm still owed — a press waiting for a
   * tap — is told to that page. A message posted at the redraw instead would reach a window whose
   * script had not run yet.
   */
  const ready = () => {
    if (answers.current.size) tellPage(true)
  }

  // A page that leaves the document it was drawn from — `location` to an outside URL, or a reload —
  // is refused by the app's own `frame-src 'self'`, and the browser leaves its error page in the
  // frame. The same version is drawn again where the reader is: the refusal is the boundary, and
  // this keeps them on their page inside it. A load of the document already shown is the page's own
  // doing, since React gives each document one load; one redraw per version and then words, so a
  // page that leaves on every load is not redrawn at the frame's pace for ever.
  const frameKey = `${canvas?.id}:${canvas?.version}:${mode}`
  const [redrawn, setRedrawn] = useState<{ key: string; document: string } | null>(null)
  const loads = useRef({ document: "", count: 0 })
  const drawnDocument = drawn?.document ?? ""
  const shownDocument = redrawn?.key === frameKey ? redrawn.document : drawnDocument
  // A version number is reused after an undo, so a new document — not a new number — is what starts
  // the redraw and the give-up words afresh.
  useEffect(() => {
    setRedrawn(null)
    setEscapedFor("")
  }, [drawnDocument])
  const escaped = escapedFor === frameKey
  const frameLoaded = () => {
    if (loads.current.document !== shownDocument) {
      loads.current = { document: shownDocument, count: 1 }
      return
    }
    loads.current.count += 1
    if (loads.current.count === 1 || !shownDocument) return
    if (redrawn?.key === frameKey) return setEscapedFor(frameKey)
    // A new frame is what draws the page again — the same version, at the reader's own position.
    const document = documentAt(SCROLLS.get(id) ?? 0)?.document ?? ""
    loads.current = { document, count: 0 }
    setRedrawn({ key: frameKey, document })
  }

  // The page's own data and its calls through the app: a data read is answered from the copy this
  // device holds and a data write goes to the host's one route (ADR 0113); the host's four reads
  // are asked freely, and a declared tool's call waits here while the reader is asked (ADR 0114).
  useEffect(() => {
    const hear = bridgeHandler({
      frame: () => frame.current?.contentWindow ?? null,
      copy: () => canvasData(id),
      write: (call) => writeCanvasData(id, call),
      call: (call) => callCanvasCall(id, call),
      consent: (tool) => askRef.current(tool),
      // A link the reader tapped opens in the platform's browser, never in this frame.
      open: (url) => openExternal(url),
      point: (point) => points.answer(point),
      ready,
    })
    window.addEventListener("message", hear)
    return () => window.removeEventListener("message", hear)
  }, [id, points])

  const update = async (changes: CanvasChanges) => {
    // A host that never answered already said so in `withHost`'s words; a refusal is this call's.
    // Either way it is thrown on, so the sheet keeps what was typed rather than closing on nothing.
    try {
      await updateCanvas(id, changes)
    } catch (failure) {
      if (hostAnswered(failure)) {
        tell.error(failure instanceof Error ? failure.message : "Couldn't change the canvas.")
      }
      throw failure
    }
  }

  const remove = async () => {
    try {
      await deleteCanvas(id)
    } catch (failure) {
      if (hostAnswered(failure)) {
        tell.error(failure instanceof Error ? failure.message : "Couldn't delete the canvas.")
      }
      // Thrown on so the question stays up: nothing was deleted.
      throw failure
    }
    tell.success("Canvas deleted.")
    setOptionsOpen(false)
    up("/canvas")
  }

  // A canvas with no version has nothing to preview: on a phone its own address is replaced by the
  // edit one — a replacement, never a push, so back cannot land here and be sent there again
  // (ADR 0130). A wide screen keeps the lane, which is already where a canvas is built, and a
  // redirect there would chase its own address for ever.
  if (canvas && canvas.version === 0 && !large)
    return <Navigate to={`/canvas/${id}/edit`} replace />

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <CanvasHeader
        canvas={canvas}
        profile={profile}
        awayWords={awayWords}
        awayNow={awayNow}
        backLabel="All canvases"
        onBack={() => up("/canvas")}
        // A wide screen draws the chat beside the page, so there is nothing to flip to (ADR 0130).
        flip={large ? undefined : "edit"}
        onFlip={() => navigate(`/canvas/${id}/edit`)}
        onOptions={() => setOptionsOpen(true)}
      />

      <div className="flex min-h-0 flex-1">
        <div className="relative min-h-0 flex-1 px-2 pb-[max(0.5rem,env(safe-area-inset-bottom))]">
          {missing ? (
            <p className="mx-auto max-w-2xl p-4 text-center text-sm text-muted-foreground">
              This canvas is gone. Its bot doesn't hold one by that name.
            </p>
          ) : drawn?.error ? (
            <p className="mx-auto max-w-2xl p-4 text-sm text-muted-foreground">{drawn.error}</p>
          ) : escaped ? (
            <p className="mx-auto max-w-2xl p-4 text-center text-sm text-muted-foreground">
              This page keeps trying to leave. Open it again from its chat.
            </p>
          ) : drawn?.document ? (
            <iframe
              ref={frame}
              key={redrawn?.key === frameKey ? `${frameKey}:again` : frameKey}
              title={canvas?.title ?? "Canvas"}
              sandbox="allow-scripts"
              srcDoc={shownDocument}
              onLoad={frameLoaded}
              className="size-full rounded-2xl border bg-background"
              data-canvas-frame
            />
          ) : (
            <p className="p-4 text-center text-sm text-muted-foreground">
              {awayNow && !html
                ? "This canvas isn't on this device, and its bot isn't answering."
                : loaded && !html
                  ? "Your bot is building it…"
                  : "Reading the canvas…"}
            </p>
          )}
        </div>
        {/* The house's list lane: 412px, the width the app already asks its text to read in
            (`w-103`, `SPLIT_FLOOR` in `lib/split.ts`), with the page beside it never narrower. */}
        {large && (
          <CanvasChat
            canvas={canvas}
            bot={profile}
            points={points}
            className="flex min-h-0 w-103 max-w-[calc(100%_-_412px)] shrink-0 flex-col border-l"
            onView={() => setUsageOpen(true)}
            onUsage={setSurface}
          />
        )}
      </div>

      <CanvasConsentDialog
        canvasTitle={canvas?.title ?? "Canvas"}
        ask={consent.current}
        total={consent.total}
        onAnswer={(allow) => void consent.answer(allow)}
      />
      <CanvasOptions
        open={optionsOpen}
        onOpenChange={setOptionsOpen}
        canvas={canvas}
        onGrant={grant}
        onUpdate={update}
        onDelete={remove}
      />
      {surface && (
        <UsageSheet
          open={usageOpen}
          onOpenChange={setUsageOpen}
          usage={surface.usage}
          providerUsage={surface.providerUsage}
        />
      )}
    </div>
  )
}

/** The numbers a canvas's usage sheet draws, read by its chat and drawn by its screen. */
interface ChatSurfaceUsage {
  usage: ContextUsage
  providerUsage?: ProviderUsage
}

/**
 * A canvas's edit screen, at `/canvas/:id/edit`: its chat, full screen, with the header's Preview and
 * the hardware back both going to the canvas's own address (ADR 0130). A wide screen already has the
 * chat beside the page, so there the address folds into the canvas's own and draws no flip at all.
 *
 * The version decides the corners: with one, Preview is the flip and there is no arrow, since the
 * corner already goes to the page; without one there is nothing to preview, so no flip is drawn and
 * a leading arrow is the way back to the list instead (ADR 0130).
 *
 * Nothing here points at the page: a point is a tap on a page, and the page is the other screen's.
 */
export function CanvasEdit() {
  const { id = "" } = useParams()
  const { up, step } = useNav()
  // The guard is per screen, so this one is its own: without it the hardware back would leave the
  // canvas for the list while the header's Preview steps to the canvas's own address.
  useEffect(() => setBackGuard(step(`/canvas/${id}`)), [step, id])
  const { canvas } = useCanvas(id)
  const profile = useLiveQuery(
    () => (canvas ? db.profiles.get(canvas.profileId) : undefined),
    [canvas?.profileId],
  )
  const large = useLarge()
  const [usageOpen, setUsageOpen] = useState(false)
  const [surface, setSurface] = useState<ChatSurfaceUsage | null>(null)
  // The first version is what makes there be a page at all, so it is also what the corners follow.
  const versioned = (canvas?.version ?? 0) >= 1
  // A wide screen's lane is the same chat, so this address has nowhere of its own to be: it is the
  // canvas's address in its place, never a step, and back cannot return here.
  if (large) return <Navigate to={`/canvas/${id}`} replace />
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <CanvasHeader
        canvas={canvas}
        profile={profile}
        awayWords={undefined}
        awayNow={false}
        backLabel={versioned ? undefined : "All canvases"}
        onBack={versioned ? undefined : () => up("/canvas")}
        undo={false}
        flip={versioned ? "preview" : undefined}
        onFlip={versioned ? () => up(`/canvas/${id}`) : undefined}
      />
      {/* Nothing to preview is said honestly: the page is not drawn yet, in the same words the
          preview's empty frame uses, and the first version takes them away (ADR 0130). */}
      {canvas && !versioned && (
        <p className="p-4 text-center text-sm text-muted-foreground">Your bot is building it…</p>
      )}
      <CanvasChat
        canvas={canvas}
        bot={profile}
        className="flex min-h-0 flex-1 flex-col"
        onView={() => setUsageOpen(true)}
        onUsage={setSurface}
      />
      {surface && (
        <UsageSheet
          open={usageOpen}
          onOpenChange={setUsageOpen}
          usage={surface.usage}
          providerUsage={surface.providerUsage}
        />
      )}
    </div>
  )
}

/**
 * A canvas's header, as both of its screens draw it: the way back where the screen has one, the
 * page's name over the one line that says whose it is and where it stands, the flip named for the
 * screen it goes to, Undo while a version sits under this one, and the menu last so the one button
 * that opens a sheet is where a hand reaches for it (ADR 0130).
 *
 * What a screen doesn't draw it isn't given: no `flip` is no flip, no `onBack` is no arrow, and the
 * edit screen offers no Undo, since the page is what a version redraws.
 */
function CanvasHeader({
  canvas,
  profile,
  awayWords,
  awayNow,
  backLabel,
  onBack,
  undo = true,
  flip,
  onFlip,
  onOptions,
}: {
  canvas: Canvas | undefined
  profile: Profile | undefined
  /** What the header says of a host that isn't answering, or a device with no network (ADR 0071). */
  awayWords: string | undefined
  awayNow: boolean
  backLabel?: string
  onBack?: () => void
  /** Whether Undo is offered at all, where a version sits below this one to walk back to. */
  undo?: boolean
  /** The screen this header's one control goes to, named on it: `edit` or `preview`. */
  flip?: "edit" | "preview"
  onFlip?: () => void
  onOptions?: () => void
}) {
  const [undoing, setUndoing] = useState(false)
  const undoVersion = async () => {
    if (!canvas || undoing) return
    setUndoing(true)
    await attempt("undo the canvas", () => undoCanvas(canvas.id))
    setUndoing(false)
  }
  return (
    <header className="flex items-center gap-3 px-4 pt-[max(0.75rem,env(safe-area-inset-top))] pb-3">
      {backLabel && onBack ? (
        <BackButton label={backLabel} variant="ghost" onClick={onBack} />
      ) : null}
      <div className="flex min-w-0 flex-1 flex-col">
        <h1 className="truncate font-semibold tracking-tight">{canvas?.title ?? "Canvas"}</h1>
        {/* A place's header, as a coding session's is: the name over the one line that says where
            the reader is — whose canvas it is, and which version of it. */}
        <p className="flex min-w-0 items-center gap-1.5 text-[11px] leading-tight text-muted-foreground">
          {profile && <span className="truncate">{profile.name}</span>}
          {canvas?.version ? (
            <>
              <span aria-hidden>·</span>
              <span className="shrink-0">v{canvas.version}</span>
            </>
          ) : null}
          {awayWords ? (
            <>
              <span aria-hidden>·</span>
              <span role="status" data-canvas-offline className="shrink-0">
                {awayWords}
              </span>
            </>
          ) : null}
        </p>
      </div>
      {flip ? (
        <Button
          variant="ghost"
          size="icon-lg"
          className="size-11 rounded-full"
          data-canvas-flip={flip}
          aria-label={flip === "edit" ? "Edit" : "Preview"}
          onClick={onFlip}
        >
          {flip === "edit" ? <PencilIcon /> : <FrameIcon />}
        </Button>
      ) : null}
      {undo && canvas?.canUndo && !awayNow ? (
        <Button
          variant="ghost"
          size="icon-lg"
          className="size-11 rounded-full"
          aria-label="Undo"
          disabled={undoing}
          onClick={() => void undoVersion()}
        >
          <Undo2Icon />
        </Button>
      ) : null}
      {/* The menu is the row's last control, so the one button that opens a sheet is always where a
          hand reaches for it, whatever else the canvas offers today. */}
      {canvas && onOptions ? (
        <Button
          variant="ghost"
          size="icon-lg"
          className="size-11 rounded-full"
          aria-label="Canvas options"
          onClick={onOptions}
        >
          <EllipsisIcon />
        </Button>
      ) : null}
    </header>
  )
}

/**
 * A canvas's chat, as its screen draws it: the record the canvas names, the providers a canvas's
 * thread asks for, the body itself, and the page re-read at every settled turn (ADR 0113). Where it
 * stands — in the desktop lane, or filling the edit screen — is the screen's, handed in as its own
 * classes; a canvas with no chat or no bot draws nothing at all. A chat beside no page (`points`
 * left out) offers no Point control, since a point is a tap on a page (ADR 0130).
 *
 * The numbers its usage sheet draws are handed up rather than drawn here: the canvas's sheet stands
 * at its screen's root, and a sheet opened inside the chat would stack in it.
 */
function CanvasChat({
  canvas,
  bot,
  points,
  className,
  onView,
  onUsage,
}: {
  canvas: Canvas | undefined
  bot: Profile | undefined
  /** The page this chat can point at; none for a screen that draws no page. */
  points?: CanvasPoints
  className: string
  /** Opens the usage sheet the composer's limit line asks for, which the screen draws. */
  onView: () => void
  onUsage: (surface: ChatSurfaceUsage) => void
}) {
  const chatId = canvas?.chatId
  const chat = useLiveQuery(() => (chatId ? db.conversations.get(chatId) : undefined), [chatId])
  const { summaries, usage, providerUsage, limit } = useChatSurface(chat, bot, onView)
  const { tracked, tokens, window: windowSize, model } = usage
  // The sheet is the screen's, and these are the numbers it draws: handed up as they change, since
  // the component that reads them is the one that draws them. They are compared field by field
  // because the usage object is read afresh on every render.
  useEffect(() => {
    onUsage({ usage: { tracked, tokens, window: windowSize, model }, providerUsage })
  }, [onUsage, tracked, tokens, windowSize, model, providerUsage])
  if (!canvas || !chat || !bot) return null
  const body = (
    <PreviewerProvider>
      <ChatBody
        chat={chat}
        bot={bot}
        summaries={summaries}
        start={undefined}
        limit={limit}
        afterSettled={() => {
          // Every turn's end re-reads the page: a stream can be open and silent (a buffering
          // proxy), so the event is never the only news. A read already in flight is joined and
          // one more is owed, so the edit's event and this cost one GET between them.
          void refreshCanvas(canvas.id).catch(() => undefined)
        }}
      />
    </PreviewerProvider>
  )
  return (
    <div className={className}>
      {points ? <CanvasPointsProvider points={points}>{body}</CanvasPointsProvider> : body}
    </div>
  )
}

/** A reader of the app's own theme, as it has landed on the page for the mode drawn. */
function readTheme() {
  const styles = getComputedStyle(document.documentElement)
  return (name: string) => styles.getPropertyValue(name)
}

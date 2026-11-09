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
import { Link, useNavigate, useParams } from "react-router"

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
import { UsageSheet } from "@/components/chat/usage-sheet"
import { useOpenDrawer } from "@/components/drawer-context"
import { ExperimentalBadge } from "@/components/experimental-badge"
import { ItemGroup } from "@/components/item-list"
import { setBackGuard } from "@/lib/native"
import { useNav } from "@/lib/nav"
import { Popup, PopupContent, PopupHeader, PopupTitle } from "@/components/popup"
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
import { db, getActiveProfile } from "@/lib/db"
import type { CanvasPoint } from "@/lib/point-marker"
import { hostAnswered } from "@/lib/hermes"
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

const SNAPS = [0.5, 1]

/** One canvas, drawn from the version its record points at, with its chat beside it or raised over it. */
export function CanvasView() {
  const { id = "" } = useParams()
  const { up, step } = useNav()
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
  const [editing, setEditing] = useState(false)
  const [undoing, setUndoing] = useState(false)
  // How many times the frame has been drawn for this version (a document that left is drawn again),
  // and whether that one redraw was already spent.
  const [escapedFor, setEscapedFor] = useState("")
  const [usageOpen, setUsageOpen] = useState(false)
  const [optionsOpen, setOptionsOpen] = useState(false)
  const frame = useRef<HTMLIFrameElement>(null)
  // Where the frame's page last said it was, and which canvas said it. Read when the document is
  // built, never per scroll: a scroll is news for the next draw, not a reason to draw again. The id
  // rides it because this screen draws every canvas's address — it isn't keyed on one — so a second
  // canvas opens at its own top rather than at the offset the first one was left at.
  const scrolled = useRef<{ id: string; at: number }>({ id, at: 0 })
  const chatId = canvas?.chatId
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
  const chat = useLiveQuery(() => (chatId ? db.conversations.get(chatId) : undefined), [chatId])
  const profile = useLiveQuery(
    () => (canvas ? db.profiles.get(canvas.profileId) : undefined),
    [canvas?.profileId],
  )
  const { summaries, usage, providerUsage, limit } = useChatSurface(chat, profile, () =>
    setUsageOpen(true),
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
    () => documentAt(scrolled.current.id === id ? scrolled.current.at : 0),
    [documentAt, id],
  )

  // The page says where it has been scrolled to, and only this screen's own frame is heard: a message
  // from any other window is not the canvas talking.
  useEffect(() => {
    const hear = (event: MessageEvent) => {
      if (event.source !== frame.current?.contentWindow) return
      const at = readScroll(event.data)
      if (at === null) return
      scrolled.current = { id, at }
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
    const document =
      documentAt(scrolled.current.id === id ? scrolled.current.at : 0)?.document ?? ""
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

  const undo = async () => {
    if (!canvas || undoing) return
    setUndoing(true)
    await attempt("undo the canvas", () => undoCanvas(canvas.id))
    setUndoing(false)
  }

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

  // The canvas's own session, as any chat body holds it: it edits the page with the host's tools, and
  // a turn's end is a version this screen re-reads (ADR 0113).
  const body =
    chat && profile ? (
      <CanvasPointsProvider points={points}>
        <PreviewerProvider>
          <ChatBody
            chat={chat}
            bot={profile}
            summaries={summaries}
            start={undefined}
            limit={limit}
            afterSettled={() => {
              // Every turn's end re-reads the page: a stream can be open and silent (a buffering
              // proxy), so the event is never the only news. A read already in flight is joined and
              // one more is owed, so the edit's event and this cost one GET between them.
              void refreshCanvas(id).catch(() => undefined)
            }}
          />
        </PreviewerProvider>
      </CanvasPointsProvider>
    ) : null

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <header className="flex items-center gap-3 px-4 pt-[max(0.75rem,env(safe-area-inset-top))] pb-3">
        <BackButton label="All canvases" variant="ghost" onClick={() => up("/canvas")} />
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
        {canvas?.canUndo && !awayNow ? (
          <Button
            variant="ghost"
            size="icon-lg"
            className="size-11 rounded-full"
            aria-label="Undo"
            disabled={undoing}
            onClick={() => void undo()}
          >
            <Undo2Icon />
          </Button>
        ) : null}
        {/* The menu is the row's last control, so the one button that opens a sheet is always where a
            hand reaches for it, whatever else the canvas offers today. */}
        {canvas ? (
          <Button
            variant="ghost"
            size="icon-lg"
            className="size-11 rounded-full"
            aria-label="Canvas options"
            onClick={() => setOptionsOpen(true)}
          >
            <EllipsisIcon />
          </Button>
        ) : null}
      </header>

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
          {/* A phone has room for the page or its chat, not both: the chat is raised over the page
              from here, so an edit is asked for with the page in sight. */}
          {!large && (
            <Button
              size="lg"
              data-canvas-edit-pill
              className="absolute right-4 bottom-[max(1rem,env(safe-area-inset-bottom))] rounded-full shadow-lg"
              onClick={() => setEditing(true)}
            >
              <PencilIcon />
              Edit
            </Button>
          )}
        </div>
        {/* The house's list lane: 412px, the width the app already asks its text to read in
            (`w-103`, `SPLIT_FLOOR` in `lib/split.ts`), with the page beside it never narrower. */}
        {large && body && (
          <div className="flex min-h-0 w-103 max-w-[calc(100%_-_412px)] shrink-0 flex-col border-l">
            {body}
          </div>
        )}
      </div>

      {!large && (
        <Popup open={editing} onOpenChange={setEditing} snapPoints={SNAPS}>
          <PopupContent bare>
            <PopupHeader className="pb-2">
              <PopupTitle>Edit with {profile?.name || "your bot"}</PopupTitle>
            </PopupHeader>
            {editing && body}
          </PopupContent>
        </Popup>
      )}
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
      <UsageSheet
        open={usageOpen}
        onOpenChange={setUsageOpen}
        usage={usage}
        providerUsage={providerUsage}
      />
    </div>
  )
}

/** A reader of the app's own theme, as it has landed on the page for the mode drawn. */
function readTheme() {
  const styles = getComputedStyle(document.documentElement)
  return (name: string) => styles.getPropertyValue(name)
}

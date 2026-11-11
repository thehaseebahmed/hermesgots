import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { useLiveQuery } from "dexie-react-hooks"
import {
  CrosshairIcon,
  EllipsisIcon,
  FrameIcon,
  PencilIcon,
  Undo2Icon,
} from "lucide-react"
import { Link, Navigate, useNavigate, useParams, useSearchParams } from "react-router"

import { ChatBody } from "@/chat-next/chat-body"
import { BackButton } from "@/components/back-button"
import {
  CanvasConsentDialog,
  CanvasOptions,
  useCanvasConsent,
} from "@/components/canvas-consent"
import { CanvasPointsProvider, type CanvasPoints } from "@/components/chat/canvas-points"
import { ChatHeader } from "@/components/chat/chat-header"
import { useChatSurface } from "@/components/chat/chat-actions"
import { BotPicker } from "@/components/chat/bot-picker"
import { Composer } from "@/components/chat/composer"
import { PreviewerProvider } from "@/components/chat/previewer"
import { UsageSheet } from "@/components/chat/usage-sheet"
import { ExperimentalBadge } from "@/components/experimental-badge"
import { ItemGroup } from "@/components/item-list"
import { setBackGuard } from "@/lib/native"
import { useNav } from "@/lib/nav"
import { Button } from "@/components/ui/button"
import { attempt } from "@/lib/attempt"
import { awayLine } from "@/lib/away"
import { bridgeHandler, pointWatch } from "@/lib/canvas-bridge"
import { canvasCss, canvasCssKey } from "@/lib/canvas-css"
import { canvasDocument, readScroll, themeTokens, type CanvasMode } from "@/lib/canvas-document"
import { CANVAS_LIBRARIES } from "@/lib/canvas-libraries"
import { keepPoint, takePoint } from "@/lib/canvas-point-pick"
import {
  callCanvasCall,
  canvasData,
  deleteCanvas,
  grantCanvasTool,
  hasVersion,
  refreshCanvas,
  refreshCanvases,
  startCanvas,
  undoCanvas,
  updateCanvas,
  useCanvas,
  useCanvasRecord,
  useCanvases,
  writeCanvasData,
  type Canvas,
  type CanvasChanges,
} from "@/lib/canvases"
import { db, getActiveProfile, type Attachment, type Profile } from "@/lib/db"
import { MAX_ATTACHMENTS } from "@/lib/attachment-caps"
import { serverConfig } from "@/lib/connection"
import { usePluginFeature } from "@/lib/features"
import { HEADER_BUTTON } from "@/lib/layout"
import type { CanvasPoint } from "@/lib/point-marker"
import { hostAnswered } from "@/lib/hermes"
import { useLarge } from "@/lib/media"
import { openExternal } from "@/lib/native"
import { useOnline } from "@/lib/online"
import { AttachmentError } from "@/lib/send-turn"
import { useDark } from "@/lib/theme"
import { BUILDING_ACTIVITY, formatRelative } from "@/lib/format"
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

/**
 * The create screen's own: a prompt and the files staged with it. The composer is the app's, in its
 * plain mode — a surface that is not a chat, which takes no `/` command and asks for words of its own
 * — so the ten-file cap, the dedupe, the refusal sentences, the tiles and their Remove are the ones
 * every other surface already has, rather than a second copy of them kept here (ADR 0131).
 */
export function CanvasPage() {
  const navigate = useNavigate()
  const { visible, archived, loaded, unsupported } = useCanvases()
  const profile = useLiveQuery(getActiveProfile, [])
  // The host's answer about its attachments route, which decides whether a staged file is saved on
  // the host or rides the first turn inline — the same answer the composer's `+` menu asks before it
  // offers. Asked before a bot is read, `undefined` is no connection rather than a hook out of order.
  const filesFeature = usePluginFeature(profile, "attachments")
  const now = useNow()
  const [starting, setStarting] = useState(false)
  const blocked = profile ? unsupported[profile.id] : undefined

  /**
   * A start, as the composer sends one: the words it holds and the files it staged. It clears its
   * own field with the send, and hands both back if this promise is refused — which is why a host
   * that didn't answer is thrown on rather than swallowed, so nothing the reader typed or picked is
   * lost before its own sentence has been said.
   */
  const create = async (text: string, attachments: Attachment[]) => {
    if (!profile || !text.trim() || starting) return
    setStarting(true)
    try {
      const started = await startCanvas(profile, text.trim(), {
        choice: profile.modelChoice,
        attachments,
        uploads: filesFeature === "yes",
      })
      // The canvas's own address, not its chat's: the preview decides which screen a canvas opens on
      // (a phone sends a canvas with no version to its chat from there), so only one screen owns that
      // rule, and the desktop no longer mounts the chat it will not draw beside the page (ADR 0130).
      navigate(`/canvas/${started.id}`)
    } catch (failure) {
      // A file the host refused is the composer's to say, on the tile it belongs to: another sentence
      // here would say the same thing twice.
      if (!(failure instanceof AttachmentError))
        tell.error(
          failure instanceof Error && failure.message
            ? failure.message
            : "Couldn't start the canvas.",
        )
      throw failure
    } finally {
      setStarting(false)
    }
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-y-auto">
      <ChatHeader
        pinned
        heading
        showBot={false}
        title={
          <>
            Canvas <ExperimentalBadge />
          </>
        }
      />

      <div className="mx-auto flex w-full max-w-2xl flex-col gap-8 px-4 pt-4 pb-[max(2rem,env(safe-area-inset-bottom))] md:pt-10">
        <section className="flex flex-col gap-3">
          <h2 className="text-center text-2xl font-semibold tracking-tight md:text-3xl">
            What should it be?
          </h2>
          {profile && (
            <div>
              <BotPicker profile={profile} />
            </div>
          )}
          {/* A canvas is started, not messaged: the composer is the app's own, in its plain mode, with
              this screen's words for the field and the press. `busy` is no session's — there is no
              reply to stop here — so only a start already under way takes the field away, and the
              composer's own `maxAttachments` is the chat's ten (ADR 0131). */}
          <Composer
            plain
            files
            maxAttachments={MAX_ATTACHMENTS}
            fieldLabel="What the canvas should be"
            sendLabel="Make it"
            placeholder="A tip calculator for a restaurant bill, in the app's own colours"
            connection={serverConfig(profile)}
            filesFeature={filesFeature}
            imagesAvailable={profile?.imageInput !== false}
            busy={false}
            disabled={starting}
            onSend={create}
            onQueue={create}
            onStop={() => false}
          />
          {blocked && <p className="text-sm text-muted-foreground">{blocked}</p>}
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
 * Where the page was last left: the preview is unmounted while the reader is on the edit screen, so
 * the position has to outlive the screen that heard it (ADR 0130). One canvas is on screen at a
 * time, so one slot is the whole of it — the id it belongs to and the position it was left at.
 * Module-level for that reason alone.
 */
let leftAt = { id: "", at: 0 }

/** Where the page of `id` was left, which is no position for a canvas this slot isn't holding. */
const scrollOf = (id: string) => (leftAt.id === id ? leftAt.at : 0)

/** The words both screens use for a canvas no bot holds any more. */
const GONE = "This canvas is gone. Its bot doesn't hold one by that name."

/** What both screens say of a canvas whose page isn't here and whose bot can't be asked for it. */
const APART = "This canvas isn't on this device, and its bot isn't answering."

/**
 * What both a canvas's screens say of a host this device can't reach, read one way for both: a device
 * with no network can't reach the host either, and is told so in its own words (ADR 0071) rather than
 * being told its bot is down.
 */
function useAway(away: boolean) {
  const online = useOnline()
  const awayNow = away || !online
  return { awayNow, words: awayLine(awayNow, online) }
}

/**
 * What both of a canvas's screens answer through its options: the reader's answers about the tools a
 * version declared, the canvas's own record, and its removal. One home for the three, so the preview
 * and the chat that is a phone's only screen of a canvas with no version cannot answer them
 * differently — and one place that says what a refusal looks like and where deleting leaves.
 */
function useCanvasManagement(id: string) {
  const navigate = useNavigate()

  /**
   * The reader's answer about a tool is kept on the host, and the host's canvas replaces the copy
   * the screen draws. A grant that couldn't be posted answers no — the page's own promise hears the
   * refusal rather than being retried on a permission the host never recorded. A host that answered
   * and refused said why (a version rewritten while the dialog was up no longer declares the tool),
   * and that is the page's answer in the host's own words, said to the reader too; only a host that
   * never landed answers no.
   */
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
    // The canvas is gone, so the list is where the reader lands — from either screen, and in this
    // entry's place: stepping back would draw the canvas that was just deleted.
    void navigate("/canvas", { replace: true })
  }

  return { grant, update, remove }
}

/**
 * One canvas, drawn from the version its record points at, with its chat beside it on a wide screen
 * and the header's Edit for the chat's own page on a phone.
 */
export function CanvasView() {
  const { id = "" } = useParams()
  const { up, back } = useNav()
  const navigate = useNavigate()
  useEffect(() => setBackGuard(back()), [back])
  const { canvas, profile, missing, loaded, away } = useCanvas(id)
  const { awayNow, words: awayWords } = useAway(away)
  const dark = useDark()
  const mode: CanvasMode = dark ? "dark" : "light"
  const html = canvas?.html
  const large = useLarge()
  // The address asks for a point to be picked on the page: the edit screen has no page of its own,
  // so it sends the reader here with `?point=1` and takes the chip back when they return.
  const [params] = useSearchParams()
  const picking = params.get("point") === "1"
  // The first version is what makes there be a page at all, so it is also what there is to point at.
  const versioned = hasVersion(canvas)
  // How many times the frame has been drawn for this version (a document that left is drawn again),
  // and whether that one redraw was already spent.
  const [escapedFor, setEscapedFor] = useState("")
  const [optionsOpen, setOptionsOpen] = useState(false)
  // The page's own Undo: the header draws the control, and this screen is what asks the host.
  const [undoing, setUndoing] = useState(false)
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
    () => documentAt(scrollOf(id)),
    [documentAt, id],
  )

  // The page says where it has been scrolled to, and only this screen's own frame is heard: a message
  // from any other window is not the canvas talking.
  useEffect(() => {
    const hear = (event: MessageEvent) => {
      if (event.source !== frame.current?.contentWindow) return
      const at = readScroll(event.data)
      if (at === null) return
      leftAt = { id, at }
    }
    window.addEventListener("message", hear)
    return () => window.removeEventListener("message", hear)
  }, [id])

  // The reader's answers about the canvas are the same three on either screen, so they are read from
  // one place: the options sheet, the page's own consent, and the delete.
  const { grant, update, remove } = useCanvasManagement(id)
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

  /** The reader changing their mind: back to the chat they came from, with nothing kept for it. */
  const cancelPick = () => void navigate(`/canvas/${id}/edit`, { replace: true })
  /**
   * A point asked for by the address, picked on the page and carried back to the chat that asked for
   * it. The arm goes through this screen's own `listen` — the same arm the chat beside the page uses —
   * so the page outlines the element under the finger, a tap answers it, and an arm posted before the
   * page's script ran is said again when the page says it is ready. The answer is kept for the chat
   * (one trip only) and the address becomes the chat's own, replacing this one so back never returns
   * to a page that was only ever a visit.
   *
   * A wide screen has the chat beside the page, so nothing needs pointing from here, and a canvas with
   * no page has nothing to point at: both replace the address with what it would have been without the
   * ask, so an old link leaves no banner waiting over a page that isn't there.
   */
  useEffect(() => {
    if (!picking) return
    if (large) {
      void navigate(`/canvas/${id}`, { replace: true })
      return
    }
    // A canvas with no version is already answered by the edit address below: it has no page to arm.
    if (!versioned) return
    return points.listen((point) => {
      keepPoint(id, point)
      void navigate(`/canvas/${id}/edit`, { replace: true })
    })
  }, [picking, large, versioned, id, navigate, points])

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
    const document = documentAt(scrollOf(id))?.document ?? ""
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

  // Undo is the page's own: the header draws the control, and this screen asks the host to walk the
  // record back one version (ADR 0113). The header never writes to a host itself.
  const undoVersion = async () => {
    if (!canvas || undoing) return
    setUndoing(true)
    await attempt("undo the canvas", () => undoCanvas(canvas.id))
    setUndoing(false)
  }

  // A canvas with no version has nothing to preview: on a phone its own address is replaced by the
  // edit one — a replacement, never a push, so back cannot land here and be sent there again
  // (ADR 0130). A wide screen keeps the lane, which is already where a canvas is built, and a
  // redirect there would chase its own address for ever.
  if (canvas && !versioned && !large) return <Navigate to={`/canvas/${id}/edit`} replace />

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {/* A wide screen draws the chat beside the page, so there is nothing to flip to (ADR 0130),
          and a canvas no bot holds has no chat to open: there is no Edit for either. */}
      <ChatHeader
        className="relative pb-2"
        title={canvas?.title ?? "Canvas"}
        subtitle={
          <>
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
          </>
        }
        showBot={false}
        heading
        leading={<BackButton label="All canvases" onClick={() => up("/canvas")} />}
        actions={
          <>
            {canvas && !missing && !large ? (
              <Button
                variant="outline"
                size="icon-lg"
                className={HEADER_BUTTON}
                data-canvas-flip="edit"
                aria-label={FLIP.edit.label}
                onClick={() => navigate(`/canvas/${id}/edit`)}
              >
                <PencilIcon />
              </Button>
            ) : null}
            {/* A host that isn't answering can't be asked to walk the record back. */}
            {canvas?.canUndo && !awayNow ? (
              <Button
                variant="outline"
                size="icon-lg"
                className={HEADER_BUTTON}
                aria-label="Undo"
                disabled={undoing}
                onClick={() => void undoVersion()}
              >
                <Undo2Icon />
              </Button>
            ) : null}
            {canvas ? (
              <Button
                variant="outline"
                size="icon-lg"
                className={HEADER_BUTTON}
                aria-label="Canvas options"
                onClick={() => setOptionsOpen(true)}
              >
                <EllipsisIcon />
              </Button>
            ) : null}
          </>
        }
      />

      <div className="flex min-h-0 flex-1">
        <div className="relative flex min-h-0 flex-1 flex-col px-2 pb-[max(0.5rem,env(safe-area-inset-bottom))]">
          {/* What the address asked for, said where the reader is looking: the page is armed, and one
              tap on an element is the answer. The row is the page's own line, so the frame below it
              keeps the whole of the rest of the screen. */}
          {picking && versioned && !large && !missing ? (
            <div
              data-point-banner
              className="mb-2 flex items-center gap-2 rounded-xl border bg-muted/60 py-1.5 pr-1.5 pl-3 text-sm"
            >
              <CrosshairIcon className="size-4 shrink-0 text-muted-foreground" aria-hidden />
              <span className="flex-1">Tap an element on the page</span>
              <Button variant="ghost" size="sm" className="h-9 rounded-lg" onClick={cancelPick}>
                Cancel
              </Button>
            </div>
          ) : null}
          {missing ? (
            <p className="mx-auto max-w-2xl p-4 text-center text-sm text-muted-foreground">{GONE}</p>
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
              className="min-h-0 w-full flex-1 rounded-2xl border bg-background"
              data-canvas-frame
            />
          ) : (
            <p className="p-4 text-center text-sm text-muted-foreground">
              {awayNow && !html
                ? APART
                : loaded && !html
                  ? BUILDING_ACTIVITY
                  : "Reading the canvas…"}
            </p>
          )}
        </div>
        {/* The house's list lane: 412px, the width the app already asks its text to read in
            (`w-103`, `LIST_LANE` in `components/app-shell.tsx`), with the page beside it never
            narrower. */}
        {large && (
          <CanvasChat
            canvas={canvas}
            bot={profile}
            points={points}
            className="flex min-h-0 w-103 max-w-[calc(100%_-_412px)] shrink-0 flex-col border-l"
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
    </div>
  )
}

/**
 * A canvas's edit screen, at `/canvas/:id/edit`: its chat, full screen, with the header's Preview and
 * the hardware back both going to the canvas's own address (ADR 0130). A wide screen already has the
 * chat beside the page, so there the address folds into the canvas's own and draws no flip at all.
 *
 * The version decides the corners: with one, Preview is the flip and there is no arrow, since the
 * corner already goes to the page; without one there is nothing to preview, so no flip is drawn and
 * a leading arrow is the way back to the list instead (ADR 0130). A record that hasn't landed yet is
 * reading: the same muted line the preview draws, and the way back to the list, never a corner that
 * a record landing a moment later would move under the reader's thumb.
 *
 * A canvas with no version opens on this screen on a phone — it is the only screen it has — so this
 * one carries the preview's options menu too, or the canvas could never be archived or deleted.
 *
 * The two states the preview says in its body are said here in the same words: a canvas no bot holds
 * is gone, and a canvas whose bot isn't answering says so rather than calling itself a page being
 * built, since the header is one row and the body is where the reader is looking.
 *
 * A point is a tap on a page, and the page is this screen's other half — so pointing here means going
 * to it: the chat's Point row replaces this address with the page's pointing one, and the element the
 * reader taps there comes back as a chip through `takePoint`. A canvas with no version has no page,
 * so its chat is given no provider and offers no Point at all.
 */
export function CanvasEdit() {
  const { id = "" } = useParams()
  const navigate = useNavigate()
  // The record alone: this screen draws no page, so what keeps it right is the list's sweep.
  const { canvas, profile, missing, away, loaded } = useCanvasRecord(id)
  const { awayNow, words: awayWords } = useAway(away)
  const large = useLarge()
  const [optionsOpen, setOptionsOpen] = useState(false)
  const { grant, update, remove } = useCanvasManagement(id)
  // The first version is what makes there be a page at all, so it is also what the corners follow.
  const versioned = hasVersion(canvas)
  /**
   * Pointing from a screen that draws no page. `listen` and `answer` are the bridge's, which only runs
   * beside a page, so they have nothing to do here; the row has somewhere else to go instead, and the
   * element picked there is waiting in `takePoint` when this chat is drawn again. It is handed over
   * once, so a chip the reader already sent or took off never comes back.
   */
  const points = useMemo<CanvasPoints>(
    () => ({
      listen: () => () => {},
      answer: () => {},
      onArm: () => void navigate(`/canvas/${id}?point=1`, { replace: true }),
      take: () => takePoint(id),
    }),
    [id, navigate],
  )
  // A record that hasn't landed yet: nothing of the canvas is known, so the body says it is reading.
  const reading = !canvas && !loaded
  // The guard is per screen and its own: a canvas with a version is answered at its own address, one
  // without has no page to show and is answered at the list. It navigates rather than stepping back —
  // the screen behind this one may be the list, and a cold address has nothing behind it at all — and
  // it takes the press, so the app never leaves on a back the screen could answer (ADR 0130).
  useEffect(
    () =>
      setBackGuard(() => {
        void navigate(versioned ? `/canvas/${id}` : "/canvas", { replace: true })
        return true
      }),
    [navigate, id, versioned],
  )
  // A wide screen's lane is the same chat, so this address has nowhere of its own to be: it is the
  // canvas's address in its place, never a step, and back cannot return here.
  if (large) return <Navigate to={`/canvas/${id}`} replace />
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <ChatHeader
        className="relative pb-2"
        title={canvas?.title ?? "Canvas"}
        subtitle={
          <>
            {profile && <span className="truncate">{profile.name}</span>}
            {canvas && hasVersion(canvas) ? (
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
          </>
        }
        showBot={false}
        heading
        leading={
          // The list is where this screen's way back goes whether the record has landed or not:
          // while it is reading, that is the only screen there is to go to.
          reading || (loaded && !versioned) ? (
            <BackButton
              label="All canvases"
              onClick={() => navigate("/canvas", { replace: true })}
            />
          ) : undefined
        }
        actions={
          <>
            {loaded && versioned ? (
              <Button
                variant="outline"
                size="icon-lg"
                className={HEADER_BUTTON}
                data-canvas-flip="preview"
                aria-label={FLIP.preview.label}
                // A replace, never a push: the page is this screen's own other half, so flipping to
                // it must not leave the chat behind for the next back press to land on.
                onClick={() => navigate(`/canvas/${id}`, { replace: true })}
              >
                <FrameIcon />
              </Button>
            ) : null}
            {canvas ? (
              <Button
                variant="outline"
                size="icon-lg"
                className={HEADER_BUTTON}
                aria-label="Canvas options"
                onClick={() => setOptionsOpen(true)}
              >
                <EllipsisIcon />
              </Button>
            ) : null}
          </>
        }
      />
      {missing ? (
        <p className="p-4 text-center text-sm text-muted-foreground">{GONE}</p>
      ) : reading ? (
        /* Nothing of the record has landed: the preview's own reading line, in its own place. */
        <p className="p-4 text-center text-sm text-muted-foreground">Reading the canvas…</p>
      ) : loaded && !versioned ? (
        /* Nothing to preview is said honestly: the page is not drawn yet, in the same words the
           preview's empty frame uses — and a host that isn't answering is not a bot that is
           building, so it says which of the two this is (ADR 0130). */
        <p className="p-4 text-center text-sm text-muted-foreground">
          {awayNow ? APART : BUILDING_ACTIVITY}
        </p>
      ) : null}
      <CanvasChat
        canvas={canvas}
        bot={profile}
        points={versioned ? points : undefined}
        reread={refreshCanvases}
        className="flex min-h-0 flex-1 flex-col"
      />
      <CanvasOptions
        open={optionsOpen}
        onOpenChange={setOptionsOpen}
        canvas={canvas}
        onGrant={grant}
        onUpdate={update}
        onDelete={remove}
      />
    </div>
  )
}

/**
 * The screen each flip goes to, as its control is labelled and drawn: one table rather than a pair
 * of ternaries, so a label and its icon cannot be read from two different answers.
 */
const FLIP = {
  edit: { label: "Edit", Icon: PencilIcon },
  preview: { label: "Preview", Icon: FrameIcon },
} as const


/**
 * A canvas's chat, as its screen draws it: the record the canvas names, the providers a canvas's
 * thread asks for, the body itself, and the page re-read at every settled turn (ADR 0113). Where it
 * stands — in the desktop lane, or filling the edit screen — is the screen's, handed in as its own
 * classes; a canvas with no chat or no bot draws nothing at all. A chat handed no provider at all
 * (`points` left out) offers no Point control — a canvas with no page has nothing to point at — while a
 * screen whose page is another address hands one whose `onArm` takes the reader there (ADR 0130).
 *
 * The usage sheet is drawn here, beside the body, because its numbers are this chat's own: the
 * composer's limit line asks for it, and the sheet's portals are where the popup lands whatever it
 * is nested in — so the chat that reads the numbers is the chat that draws them, and no screen has
 * to hand them up to a root it does not own.
 */
function CanvasChat({
  canvas,
  bot,
  points,
  reread = refreshCanvas,
  className,
}: {
  canvas: Canvas | undefined
  bot: Profile | undefined
  /** What this chat can point at; none for a canvas with no page to point at. */
  points?: CanvasPoints
  /** What a settled turn reads again: the page this chat sits beside, or the record of a screen that
   * draws none — so a canvas's chat on the edit screen never asks for a document either. */
  reread?: (id: string) => Promise<unknown>
  className: string
}) {
  const chatId = canvas?.chatId
  const chat = useLiveQuery(() => (chatId ? db.conversations.get(chatId) : undefined), [chatId])
  const [usageOpen, setUsageOpen] = useState(false)
  const view = useCallback(() => setUsageOpen(true), [])
  const { summaries, usage, providerUsage, limit } = useChatSurface(chat, bot, view)
  const { tracked, tokens, window: windowSize, model } = usage
  if (!canvas || !chat || !bot) return null
  const body = (
    <PreviewerProvider>
      <ChatBody
        chat={chat}
        bot={bot}
        summaries={summaries}
        limit={limit}
        afterSettled={() => {
          // Every turn's end re-reads what this screen draws: a stream can be open and silent (a
          // buffering proxy), so the event is never the only news. A read already in flight is joined
          // and one more is owed, so the edit's event and this cost one read between them.
          void reread(canvas.id).catch(() => undefined)
        }}
      />
    </PreviewerProvider>
  )
  return (
    <div className={className}>
      {points ? <CanvasPointsProvider points={points}>{body}</CanvasPointsProvider> : body}
      <UsageSheet
        open={usageOpen}
        onOpenChange={setUsageOpen}
        usage={{ tracked, tokens, window: windowSize, model }}
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

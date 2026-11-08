import { useEffect, useMemo, useRef, useState } from "react"
import { useLiveQuery } from "dexie-react-hooks"
import { ArrowLeftIcon, FrameIcon, MenuIcon, PencilIcon, PlusIcon, Undo2Icon } from "lucide-react"
import { Link, useNavigate, useParams } from "react-router"

import { ChatBody } from "@/chat-next/chat-body"
import { Bot } from "@/components/bot"
import { useChatSurface } from "@/components/chat/chat-actions"
import { BotPicker } from "@/components/chat/bot-picker"
import { PreviewerProvider } from "@/components/chat/previewer"
import { UsageSheet } from "@/components/chat/usage-sheet"
import { useOpenDrawer } from "@/components/drawer-context"
import { ExperimentalBadge } from "@/components/experimental-badge"
import { ItemRow } from "@/components/item-list"
import { Popup, PopupContent, PopupHeader, PopupTitle } from "@/components/popup"
import { Button } from "@/components/ui/button"
import { Textarea } from "@/components/ui/textarea"
import { attempt } from "@/lib/attempt"
import { canvasDocument, readScroll, themeTokens, type CanvasMode } from "@/lib/canvas-document"
import { refreshCanvas, startCanvas, undoCanvas, useCanvas, useCanvases } from "@/lib/canvases"
import { db, getActiveProfile } from "@/lib/db"
import { useLarge } from "@/lib/media"
import { useDark } from "@/lib/theme"
import { formatRelative } from "@/lib/format"
import { useNow } from "@/lib/threads"

/**
 * The two Canvas routes: `/canvas` lists every bot's pages beside the prompt that makes one, and
 * `/canvas/:id` draws one page in a sandboxed frame (ADR 0114).
 */

export function CanvasPage() {
  const openDrawer = useOpenDrawer()
  const navigate = useNavigate()
  const { canvases, loaded, unsupported } = useCanvases()
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
            <Textarea
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
              className="min-h-24 resize-none rounded-3xl bg-background shadow-lg shadow-black/5 dark:bg-input/30"
            />
            <Button
              type="submit"
              size="lg"
              className="self-end rounded-full"
              disabled={!profile || !prompt.trim() || starting}
            >
              <PlusIcon />
              {starting ? "Starting…" : "Make it"}
            </Button>
            {blocked && <p className="text-sm text-muted-foreground">{blocked}</p>}
          </form>
        </section>

        <section className="flex flex-col gap-2">
          {loaded && canvases.length === 0 && !blocked && (
            <p className="py-8 text-center text-sm text-muted-foreground">
              No canvases yet. Ask for one above and your bot builds it.
            </p>
          )}
          {canvases.map((canvas) => (
            <ItemRow
              key={canvas.id}
              icon={<FrameIcon />}
              botId={canvas.profileId}
              title={canvas.title}
              when={canvas.at ? formatRelative(canvas.at, now) : undefined}
              line={
                canvas.version > 0
                  ? `Version ${canvas.version}`
                  : "Your bot is building it…"
              }
              link={{ to: `/canvas/${canvas.id}` }}
            />
          ))}
        </section>
      </div>
    </div>
  )
}

const SNAPS = [0.5, 1]

/** One canvas, drawn from the version its record points at, with its chat beside it or raised over it. */
export function CanvasView() {
  const { id = "" } = useParams()
  const { canvas, missing, loaded } = useCanvas(id)
  const dark = useDark()
  const mode: CanvasMode = dark ? "dark" : "light"
  const html = canvas?.html
  const large = useLarge()
  const [editing, setEditing] = useState(false)
  const [undoing, setUndoing] = useState(false)
  const [usageOpen, setUsageOpen] = useState(false)
  const frame = useRef<HTMLIFrameElement>(null)
  // Where the frame's page last said it was, and which canvas said it. Read when the document is
  // built, never per scroll: a scroll is news for the next draw, not a reason to draw again. The id
  // rides it because this screen draws every canvas's address — it isn't keyed on one — so a second
  // canvas opens at its own top rather than at the offset the first one was left at.
  const scrolled = useRef<{ id: string; at: number }>({ id, at: 0 })
  const chatId = canvas?.chatId
  const chat = useLiveQuery(() => (chatId ? db.conversations.get(chatId) : undefined), [chatId])
  const profile = useLiveQuery(
    () => (canvas ? db.profiles.get(canvas.profileId) : undefined),
    [canvas?.profileId],
  )
  const { summaries, usage, providerUsage, limit } = useChatSurface(chat, profile, () =>
    setUsageOpen(true),
  )
  const drawn = useMemo(() => {
    if (!html) return null
    const tokens = themeTokens(readTheme())
    try {
      return {
        document: canvasDocument(html, {
          mode,
          tokens,
          scroll: scrolled.current.id === id ? scrolled.current.at : 0,
        }),
      }
    } catch {
      return { error: "This canvas can't be drawn: its document has no head." }
    }
  }, [id, html, mode])

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

  const undo = async () => {
    if (!canvas || undoing) return
    setUndoing(true)
    await attempt("undo the canvas", () => undoCanvas(canvas.id))
    setUndoing(false)
  }

  // The canvas's own session, as any chat body holds it: it edits the page with the host's tools, and
  // a turn's end is a version this screen re-reads (ADR 0113).
  const body =
    chat && profile ? (
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
    ) : null

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <header className="flex items-center gap-3 px-4 pt-[max(0.75rem,env(safe-area-inset-top))] pb-3">
        <Button
          variant="ghost"
          size="icon-lg"
          className="size-11 rounded-full"
          aria-label="All canvases"
          nativeButton={false}
          render={<Link to="/canvas" />}
        >
          <ArrowLeftIcon />
        </Button>
        <div className="flex min-w-0 flex-1 items-center gap-2">
          <h1 className="truncate font-semibold tracking-tight">{canvas?.title ?? "Canvas"}</h1>
          {canvas?.version ? (
            <span className="shrink-0 text-xs text-muted-foreground">v{canvas.version}</span>
          ) : null}
        </div>
        {canvas?.canUndo ? (
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
        {profile && <Bot id={profile.id} className="size-7 shrink-0" />}
      </header>

      <div className="flex min-h-0 flex-1">
        <div className="relative min-h-0 flex-1 px-2 pb-[max(0.5rem,env(safe-area-inset-bottom))]">
          {missing ? (
            <p className="mx-auto max-w-2xl p-4 text-center text-sm text-muted-foreground">
              This canvas is gone. Its bot doesn't hold one by that name.
            </p>
          ) : drawn?.error ? (
            <p className="mx-auto max-w-2xl p-4 text-sm text-muted-foreground">{drawn.error}</p>
          ) : drawn?.document ? (
            <iframe
              ref={frame}
              key={`${canvas?.id}:${canvas?.version}:${mode}`}
              title={canvas?.title ?? "Canvas"}
              sandbox="allow-scripts"
              srcDoc={drawn.document}
              className="size-full rounded-2xl border bg-background"
              data-canvas-frame
            />
          ) : (
            <p className="p-4 text-center text-sm text-muted-foreground">
              {loaded ? "Your bot is building it…" : "Reading the canvas…"}
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

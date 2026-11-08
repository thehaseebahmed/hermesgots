import { useMemo, useState } from "react"
import { useLiveQuery } from "dexie-react-hooks"
import { ArrowLeftIcon, FrameIcon, MenuIcon, PlusIcon } from "lucide-react"
import { Link, useNavigate, useParams } from "react-router"

import { Bot } from "@/components/bot"
import { BotPicker } from "@/components/chat/bot-picker"
import { useOpenDrawer } from "@/components/drawer-context"
import { ExperimentalBadge } from "@/components/experimental-badge"
import { ItemRow } from "@/components/item-list"
import { Button } from "@/components/ui/button"
import { Textarea } from "@/components/ui/textarea"
import { attempt } from "@/lib/attempt"
import { canvasDocument, themeTokens, type CanvasMode } from "@/lib/canvas-document"
import { startCanvas, useCanvas, useCanvases } from "@/lib/canvases"
import { db, getActiveProfile } from "@/lib/db"
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

/** One canvas, drawn from its newest version. */
export function CanvasView() {
  const { id } = useParams()
  const { canvas, missing, loaded } = useCanvas(id ?? "")
  const dark = useDark()
  const mode: CanvasMode = dark ? "dark" : "light"
  const html = canvas?.html
  const profile = useLiveQuery(
    () => (canvas ? db.profiles.get(canvas.profileId) : undefined),
    [canvas?.profileId],
  )
  const drawn = useMemo(() => {
    if (!html) return null
    const tokens = themeTokens(readTheme())
    try {
      return { document: canvasDocument(html, { mode, tokens }) }
    } catch {
      return { error: "This canvas can't be drawn: its document has no head." }
    }
  }, [html, mode])

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
        {profile && <Bot id={profile.id} className="size-7 shrink-0" />}
      </header>

      <div className="min-h-0 flex-1 px-2 pb-[max(0.5rem,env(safe-area-inset-bottom))]">
        {missing ? (
          <p className="mx-auto max-w-2xl p-4 text-center text-sm text-muted-foreground">
            This canvas is gone. Its bot doesn't hold one by that name.
          </p>
        ) : drawn?.error ? (
          <p className="mx-auto max-w-2xl p-4 text-sm text-muted-foreground">{drawn.error}</p>
        ) : drawn?.document ? (
          <iframe
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
      </div>
    </div>
  )
}

/** A reader of the app's own theme, as it has landed on the page for the mode drawn. */
function readTheme() {
  const styles = getComputedStyle(document.documentElement)
  return (name: string) => styles.getPropertyValue(name)
}

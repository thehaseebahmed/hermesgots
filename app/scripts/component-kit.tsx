/**
 * What the component tests stand on: the faked HTTP boundary's answer, the passes that let a
 * screen's reads land, the queries a test asks of the DOM, and the AFK pop-up on a phone's screen.
 * The suite is `node --test --import ./scripts/component-hooks.mjs`; this is the part of it no test
 * should spell twice.
 */
import assert from "node:assert/strict"
import { act } from "react"
import { createRoot } from "react-dom/client"
import { MemoryRouter, Route, Routes, useLocation, useNavigate } from "react-router"

import { AfkPopup } from "@/components/afk"
import { AppShell } from "@/components/app-shell"
import { DEFAULT_SETTINGS, db, type Message, type Profile, type Settings } from "@/lib/db"
import { fingerprintOf, orderOf } from "@/lib/dictation-log"
import type { SessionMessage } from "@/lib/hermes"
import { THINKING_WORD } from "@/lib/thinking"
import { WAKE_PROMPT_FOOTER, WAKE_PROMPT_HEADER } from "@/lib/wake-prompt"
import { ChatPage } from "@/routes/chat"

export function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  })
}

/**
 * Transcript rows for a session, each taking the next id and a time that follows it: a row, a call
 * and its result, and the two together. `reset` starts the ids over for the next case.
 */
export function transcriptRows(start = 0) {
  let last = start
  const row = (role: string, content: string | null, extra: Partial<SessionMessage> = {}) =>
    ({ id: ++last, role, content, timestamp: 1_000 + last, ...extra }) as SessionMessage
  const call = (name: string, text?: string) =>
    row("assistant", text ?? null, {
      tool_calls: [
        { id: `call-${last + 1}`, type: "function", function: { name, arguments: "{}" } },
      ],
    })
  const result = (calling: SessionMessage) =>
    row("tool", "{}", {
      tool_call_id: calling.tool_calls![0].id,
      tool_name: calling.tool_calls![0].function.name,
    })
  const pair = (name: string, text?: string) => {
    const calling = call(name, text)
    return [calling, result(calling)]
  }
  return { row, call, result, pair, reset: (to = start) => void (last = to) }
}

/** Answers a session's transcript the way the host pages it: newest rows first, each page oldest first. */
export function serveTranscript(rows: SessionMessage[]) {
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = new URL(String(input))
    if (!/\/messages$/.test(url.pathname)) return json({ error: { message: "no route" } }, 404)
    const limit = Number(url.searchParams.get("limit"))
    const offset = Number(url.searchParams.get("offset"))
    const page = [...rows].sort((a, b) => b.id - a.id).slice(offset, offset + limit)
    return json({ data: page.reverse() })
  }) as unknown as typeof fetch
}

/** The wake run's own input, as the plugin posts it: the pinned header, the result, core's footer. */
export const wakePromptText = (body = "A finding") =>
  `${WAKE_PROMPT_HEADER}child-1]\n${body}\n\n${WAKE_PROMPT_FOOTER} to keep you going]`

/** Waits for the reads a screen starts to land, then lets React commit what they changed. */
export async function settle() {
  for (let quiet = 0; quiet < 4; quiet += 1)
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0))
    })
}

/**
 * A connection of a test's own. What a connection's plugin answered is remembered for the page, so a
 * test of a host that answers differently (an older plugin) names its own rather than sharing one.
 */
export const connection = (name: string) => ({
  baseUrl: `http://${name}.test/v1`,
  apiKey: "test-key",
})

export function botProfile(name: string, patch: Partial<Profile> = {}): Profile {
  const server = connection(name)
  return {
    id: "bot-1",
    name: "A bot",
    baseUrl: server.baseUrl,
    apiKey: server.apiKey,
    model: "test/model",
    botId: "bot-1",
    createdAt: 1,
    updatedAt: 1,
    ...patch,
  }
}

/** What a host answers about its log: the totals it counts, across the fingerprint beside them. */
export function dictationTotals<
  T extends { at: number; seenAt?: number; words: number; ms: number },
>(rows: T[], clearedAt = 0) {
  const words = rows.reduce((total, row) => total + row.words, 0)
  const ms = rows.reduce((total, row) => total + row.ms, 0)
  return { words, ms, ...fingerprintOf(rows, clearedAt) }
}

/**
 * One page of a host's log, read the way its route reads it: newest first by the host's own clock, and
 * under the keyset cursor `(seen_at, id)` — a bound on the time alone would skip every row tied with
 * it, which is a take a mirror could then never reach. Tests that fake that route share this, so the
 * order and the cursor they answer with are the ones the app really talks to.
 */
export function dictationPage<T extends { id: string; at: number; seenAt?: number }>(
  rows: T[],
  query: {
    before?: string | number | null
    beforeId?: string | null
    limit?: string | number | null
  } = {},
): T[] {
  const before = query.before === null || query.before === undefined ? null : Number(query.before)
  const beforeId = query.beforeId || null
  const older = [...rows].sort(
    (one, two) => orderOf(two) - orderOf(one) || (one.id < two.id ? 1 : -1),
  )
  const under = (row: T) => {
    if (before === null) return true
    if (beforeId === null) return orderOf(row) < before
    return orderOf(row) < before || (orderOf(row) === before && row.id < beforeId)
  }
  return older.filter(under).slice(0, Number(query.limit ?? 50))
}

export async function seedSettings(patch: Partial<Omit<Settings, "id">> = {}) {
  await db.settings.clear()
  await db.settings.put({ ...DEFAULT_SETTINGS, ...patch, id: "settings" })
}

export async function mount(element: React.ReactNode, body: () => Promise<void>) {
  const container = document.createElement("div")
  document.body.append(container)
  const root = createRoot(container)
  try {
    await act(async () => root.render(element))
    await settle()
    await body()
  } finally {
    await act(async () => root.unmount())
    container.remove()
  }
}

export const chatScreen = (id: string) => (
  <MemoryRouter initialEntries={[`/c/${id}`]}>
    <Routes>
      <Route path="/c/:id" element={<ChatPage slot="route" />} />
    </Routes>
  </MemoryRouter>
)

/** Runs `body` as a reader whose screen is `width` px across, then puts the width back. */
export const atWidth = (width: number, body: () => Promise<void>) => async () => {
  const before = window.innerWidth
  window.innerWidth = width
  try {
    await body()
  } finally {
    window.innerWidth = before
  }
}

export const laptop = (body: () => Promise<void>) => atWidth(1440, body)

export function SwitchTo({
  to,
  replace,
  quiet,
}: {
  to: string
  replace?: boolean
  quiet?: boolean
}) {
  const navigate = useNavigate()
  return (
    <button
      type="button"
      data-switch
      onClick={() => navigate(to, { replace, state: quiet ? { quiet: true } : undefined })}
    >
      switch
    </button>
  )
}

export const phone = (
  entry: string,
  to: string,
  { routes, replace, quiet }: { routes?: React.ReactNode; replace?: boolean; quiet?: boolean } = {},
) => (
  <MemoryRouter initialEntries={[entry]}>
    <Path />
    <SwitchTo to={to} replace={replace} quiet={quiet} />
    <Routes>
      <Route element={<AppShell />}>
        <Route path="/" element={<ChatPage slot="route" />} />
        <Route path="c/:id" element={<ChatPage slot="route" />} />
        {routes}
      </Route>
    </Routes>
  </MemoryRouter>
)

export interface SeededChat {
  id: string
  profileId?: string
  title?: string
  main?: boolean
  at?: number
  messages?: (string | { id?: string; content: string; at?: number; role?: "user" | "assistant" })[]
}

export async function seedChats(
  chats: SeededChat[],
  {
    bots = [],
    botThreads = false,
    active = bots[0]?.id,
    settings = {},
  }: {
    bots?: Profile[]
    botThreads?: boolean
    active?: string
    settings?: Partial<Omit<Settings, "id">>
  } = {},
) {
  await seedSettings({ developer: true, botThreads, activeProfileId: active, ...settings })
  await db.profiles.clear()
  await db.profiles.bulkPut(bots)
  await db.conversations.clear()
  await db.messages.clear()
  const at = (chat: SeededChat, place: number) => chat.at ?? 10 + place
  await db.conversations.bulkPut(
    chats.map((chat, place) => ({
      id: chat.id,
      profileId: chat.profileId ?? active ?? "",
      title: chat.title ?? "A chat",
      main: chat.main,
      titleEdited: true,
      hermesSessionId: `memento-${chat.id}`,
      createdAt: at(chat, place),
      updatedAt: at(chat, place),
      changedAt: 10,
    })),
  )
  await db.messages.bulkPut(
    chats.flatMap((chat, place) =>
      (chat.messages ?? []).map((one, said) => {
        const message = typeof one === "string" ? { content: one } : one
        return {
          id: message.id ?? `${chat.id}-${said}`,
          conversationId: chat.id,
          role: message.role ?? ("user" as const),
          content: message.content,
          status: "done" as const,
          createdAt: message.at ?? at(chat, place) + 1 + said,
        }
      }),
    ),
  )
  globalThis.fetch = async () => json({})
}

export interface Animated {
  pane: string | null
  element: string
  keyframes: Keyframe[]
  options: KeyframeAnimationOptions
  held: string
  shown: string
  body: string
  /** What the animated element itself holds. */
  text: string
}

export function spyAnimate() {
  const asked: Animated[] = []
  const animate = HTMLElement.prototype.animate
  HTMLElement.prototype.animate = function (keyframes, options) {
    const panes = [...document.querySelectorAll('[data-slot="chat-pane"]')]
    const words = (held: boolean) =>
      panes
        .filter((pane) => pane.hasAttribute("inert") === held)
        .map((pane) => pane.textContent ?? "")
        .join("|")
    asked.push({
      pane: this.getAttribute("data-pane"),
      element: this.tagName.toLowerCase(),
      keyframes: Array.isArray(keyframes) ? (keyframes as Keyframe[]) : [],
      options: typeof options === "number" ? { duration: options } : (options ?? {}),
      held: words(true),
      shown: words(false),
      body: document.body.textContent ?? "",
      text: this.textContent ?? "",
    })
    return animate.call(this, keyframes, options)
  }
  return {
    asked,
    onPanes: () => asked.filter((one) => one.pane !== null),
    onScreen: () => asked.filter((one) => one.element === "main"),
    overHeld: () => asked.filter((one) => one.pane !== null && one.held !== ""),
    restore() {
      HTMLElement.prototype.animate = animate
    },
  }
}

export async function seedChat({
  id,
  projectId,
  messages = [],
  profile,
  settings = {},
}: {
  id: string
  projectId?: string
  messages?: Message[]
  profile: Profile
  settings?: Partial<Omit<Settings, "id">>
}) {
  await seedSettings(settings)
  await db.profiles.clear()
  await db.profiles.put(profile)
  await db.messages.clear()
  await db.conversations.clear()
  await db.conversations.put({
    id,
    profileId: profile.id,
    title: projectId ? "A session" : "A chat",
    hermesSessionId: `${id}-hermes`,
    projectId,
    createdAt: 1,
    updatedAt: 1,
    changedAt: 1,
  })
  await db.messages.bulkPut(messages.map((message) => ({ ...message, conversationId: id })))
}

export function mountAfk(
  config: { baseUrl: string; apiKey?: string },
  projectId: string,
  body: () => Promise<void>,
  { library }: { library?: boolean } = {},
) {
  return mount(
    <AfkPopup
      open
      onOpenChange={() => {}}
      config={config}
      projectId={projectId}
      library={library}
    />,
    body,
  )
}

export async function click(element: Element | null) {
  assert.ok(element, "the control is on screen")
  await act(async () => {
    element.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }))
  })
  await settle()
}

export async function until(check: () => Promise<boolean>, what: string, ms = 5000) {
  for (const end = Date.now() + ms; Date.now() < end;) {
    if (await check()) return
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  assert.fail(`waited for ${what}`)
}

/** Escape, the way a pop-up closes, and the sheet `at` points at to be gone. */
export async function shutSheet(at: () => Element | null) {
  await act(async () => {
    at()?.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }),
    )
  })
  await until(async () => !at(), "the sheet shut")
}

/**
 * Fires the `ResizeObserver`s a screen is watching with, which a DOM without layout never does. With
 * `near`, only the observers watching that box (or a box inside or around it) report, so a test
 * measuring one part of a screen doesn't also wake the thread's own scroll maths.
 */
export async function resized(near?: string) {
  const observers = (
    globalThis as unknown as { __resizeObservers?: { watching: Element[]; report(): void }[] }
  ).__resizeObservers
  assert.ok(observers, "the harness records the observers a screen makes")
  const box = near ? document.querySelector(near) : null
  const watching = (one: Element) => !box || one === box || box.contains(one) || one.contains(box)
  await act(async () => {
    for (const observer of observers) {
      if (!observer.watching.length) continue
      if (!observer.watching.some(watching)) continue
      observer.report()
    }
  })
  await settle()
}

/**
 * Runs `body` as a reader who asked for no motion. The preference is flipped where the query is read,
 * not in `matchMedia`: a module keeps one list per query, so a stub swapped in afterwards is never
 * asked and the component would draw the moving version.
 */
export async function withReducedMotion(body: () => Promise<void>) {
  const flag = globalThis as unknown as { __reducedMotion?: boolean }
  const before = flag.__reducedMotion
  flag.__reducedMotion = true
  try {
    await body()
  } finally {
    flag.__reducedMotion = before
  }
}

/**
 * Records every landing a screen asks for (`scrollIntoView` with `block: "end"`), so a test can read
 * where it was sent. Restore it when the test is done.
 */
export function spyScrollIntoView() {
  const into: ScrollIntoViewOptions[] = []
  const scrolled = HTMLElement.prototype.scrollIntoView
  HTMLElement.prototype.scrollIntoView = function (options?: boolean | ScrollIntoViewOptions) {
    if (typeof options === "object" && options?.block === "end") into.push(options)
  }
  return {
    /** The landings recorded so far, in the order they were asked for. */
    into,
    restore() {
      HTMLElement.prototype.scrollIntoView = scrolled
    },
  }
}

export async function type(element: Element | null, value: string) {
  assert.ok(element, "the field is on screen")
  const prototype =
    element.tagName === "TEXTAREA" ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype
  const setter = Object.getOwnPropertyDescriptor(prototype, "value")?.set
  await act(async () => {
    setter?.call(element, value)
    element.dispatchEvent(new Event("input", { bubbles: true }))
  })
  await settle()
}

export const text = () => document.body.textContent ?? ""
export const find = (selector: string) => document.querySelector(selector)
export const findAll = (selector: string) => [...document.querySelectorAll(selector)]
export const findText = (selector: string, label: string) =>
  findAll(selector).find((one) => one.textContent?.includes(label)) ?? null

/**
 * Asserts nothing on the screen matches a selector, or a control reading `label`. The failure names
 * what should have been absent, rather than printing the element that was found.
 */
export function absent(selector: string, label?: string) {
  const found = label === undefined ? find(selector) : findText(selector, label)
  const what = label === undefined ? selector : `${selector} reading "${label}"`
  assert.ok(!found, `nothing on the screen matches ${what}`)
}

export const composerField = () =>
  find('textarea[aria-label="Message"]') as HTMLTextAreaElement | null
export const slashOptions = () => findAll('[role="option"]').map((row) => row.textContent ?? "")
export const offersCommand = (name: string) => slashOptions().some((row) => row.startsWith(name))

export async function pressEnter() {
  await act(async () => {
    composerField()?.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }),
    )
  })
  await settle()
}

/** The address on screen, drawn beside the router so a test can read it without asking one. */
export const Path = () => <p data-path>{useLocation().pathname}</p>
export const path = () => find("[data-path]")?.textContent ?? ""

/** A reply's thinking rows in the order drawn — the row itself, button or status row alike. */
export const thinkingLines = () =>
  findAll("[data-slot=thinking-line]")
    .map((row) => row.firstElementChild)
    .filter((row): row is Element => row !== null)

export function onlyThinkingLine() {
  const found = thinkingLines()
  assert.equal(found.length, 1, "one thinking line, once per reply")
  return found[0]
}

export const lineLabel = (line: Element) => line.textContent?.trim() ?? ""

/** Whether a live thinking row says its own word, never one of the status line's (ADR 0070). */
export const saysThinking = (text: string) => text === THINKING_WORD

export const expanded = (line: Element) => line.getAttribute("aria-expanded")

export type Call = { method: string; path: string; body: Record<string, unknown> | null }

export const workflowStage = (name: string, extra: Record<string, unknown> = {}) => ({
  name,
  steps: [],
  check: null,
  loop: null,
  ships: false,
  ...extra,
})

export const DEFAULT_AFK_PROMPT =
  "# Work in checkpoints\n\nSmall slices of the issue, one at a time."

/** One request a faked host was sent, as its route read it. */
export interface HostAsk {
  host: string
  path: string
  search: string
  /** What a write posted, where it posted one. */
  body?: string
  authorization: string | null
}

/** The type the media route serves a suffix as: its own map, near enough for a test's fixture. */
const SERVED: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".svg": "image/svg+xml",
  ".mp4": "video/mp4",
  ".mp3": "audio/mpeg",
  ".pdf": "application/pdf",
  ".txt": "text/plain",
  ".md": "text/markdown",
}

/**
 * A host's plugin as every media test reads it: `info` advertising `features` ("away" is a host that
 * never answered), and the media route answering a path's bytes as the type its suffix names, or
 * refusing it with `failure`'s status — 404 being a route that says it has no such file. Every
 * request is recorded, so a test can ask which paths were read and with which key.
 */
export function mediaHost({
  host = "",
  features = ["attachments", "media", "media_url"],
  fail = [],
  failure = 404,
  type,
  asked = [],
}: {
  /** The host whose URLs this answers; every host when it is left empty. */
  host?: string
  /** What `info` advertises, or "away" for a host that didn't answer at all. */
  features?: string[] | "away"
  /** Path suffixes the media route refuses. */
  fail?: string[]
  /** The status a refused path is answered with. */
  failure?: number
  /** What a path is served as, where it isn't the type its suffix names. */
  type?: (path: string) => string
  /** Requests recorded so far, so a second host keeps one count going. */
  asked?: HostAsk[]
} = {}) {
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = input instanceof Request ? input : null
    const url = new URL(String(request ? request.url : input))
    if (host && !url.host.startsWith(host)) return json({})
    const sent = new Headers(init?.headers)
    asked.push({
      host: url.host,
      path: url.pathname,
      search: url.search,
      body: typeof init?.body === "string" ? init.body : undefined,
      authorization: sent.get("authorization") ?? request?.headers.get("authorization") ?? null,
    })
    if (url.pathname.endsWith("/plugins/memento/info"))
      return features === "away" ? json({}, 503) : json({ name: "memento", features })
    if (url.pathname.endsWith("/plugins/memento/media/url")) {
      // The mint: a URL for one path, signed by the host and good for minutes. Nothing is read
      // into the app here — an <img> or a <video> draws from this URL itself.
      const path = String(JSON.parse(String(init?.body ?? "{}")).path ?? "")
      if (fail.some((suffix) => path.endsWith(suffix)))
        return json({ error: { message: "No such file." } }, failure)
      const served = type?.(path) ?? SERVED[path.slice(path.lastIndexOf(".")).toLowerCase()]
      const kind = served ?? "application/octet-stream"
      const media = `${url.origin}${url.pathname.replace(/\/url$/, "")}`
      return json({
        object: "memento.media_url",
        path,
        url: `${media}?path=${encodeURIComponent(path)}&token=mock-token`,
        type: kind,
        size: 12,
      })
    }
    if (url.pathname.endsWith("/plugins/memento/media")) {
      const path = url.searchParams.get("path") ?? ""
      if (fail.some((suffix) => path.endsWith(suffix)))
        return json({ error: { message: "No such file." } }, failure)
      const served = type?.(path) ?? SERVED[path.slice(path.lastIndexOf(".")).toLowerCase()]
      const kind = served ?? "application/octet-stream"
      return new Response(new Blob(["bytes"], { type: kind }), {
        headers: { "content-type": kind },
      })
    }
    return json({})
  }) as typeof fetch
  return asked
}

/** How many times a faked host was asked for a route, or for one path within it. */
export const askedFor = (asked: HostAsk[], part: string) =>
  asked.filter((one) => `${one.path}${one.search}`.includes(part)).length

/** What a faked host was asked to sign a URL for, and the key it was asked with, in order. */
export const mediaAsks = (asked: HostAsk[]) =>
  asked
    .filter((one) => one.path.endsWith("/plugins/memento/media/url"))
    .map((one) => ({
      path: String(JSON.parse(one.body ?? "{}").path ?? ""),
      authorization: one.authorization,
    }))

/** The paths a faked host was asked to sign a URL for, in the order it was asked. */
export const mediaReads = (asked: HostAsk[]) => mediaAsks(asked).map((one) => one.path)

/** One hold as a test gives it: number and title, and the stage its session is in. */
export type HoldRow = {
  number: number
  repo?: string
  title?: string
  stage?: string | null
  stage_name?: string | null
  stalled?: string | null
}

/**
 * The account's prompt library as this device holds it, cleared and then seeded: entries go in with
 * their own clock, and no `prompt:` tombstone from an earlier test is left behind to fight them.
 */
export async function seedPrompts(
  entries: { id?: string; name: string; tags?: string[]; body: string; updatedAt?: number }[],
) {
  await db.prompts.clear()
  const tombstones = await db.tombstones.where("id").startsWith("prompt:").toArray()
  await db.tombstones.bulkDelete(tombstones.map((one) => one.id))
  await db.prompts.bulkPut(
    entries.map((entry, index) => ({
      id: entry.id ?? `e-${index + 1}`,
      name: entry.name,
      tags: entry.tags ?? [],
      body: entry.body,
      updatedAt: entry.updatedAt ?? index + 1,
    })),
  )
}

export function afkHost({
  projectId = "project-1",
  features = ["afk", "afk_switch", "afk_workflows", "afk_pipeline", "afk_prompt"],
  workflow = "preset:staged",
  stage = "build",
  stageName = "Build",
  prompt = DEFAULT_AFK_PROMPT,
  promptId = null,
  promptRefusal = null,
  holds = null,
  pickCount = null,
  pickRefusal = null,
  pickBudget = null,
  holdsHeld = null,
  budgetRefusal = null,
  usageThreshold = null,
  thresholdRefusal = null,
  thresholdAnswer,
  hostProvider = "anthropic",
  windows = null,
  deciding = null,
}: {
  projectId?: string
  features?: string[]
  workflow?: string
  stage?: string | null
  stageName?: string | null
  prompt?: string
  /** The library entry the host says the Prompt was copied from; null is words typed here. */
  promptId?: string | null
  promptRefusal?: string | null
  /** The holds the host answers, oldest first; null is a host from before the pick count. */
  holds?: HoldRow[] | null
  /** The project's pick count; null is a host that answers none. */
  pickCount?: number | null
  /** What a pick count write is refused with, where the host refuses one. */
  pickRefusal?: string | null
  /** The bot's pick budget, 1–10, on both the project's read and the bot's own; null is a host from
   * before the budget, which answers its own default on the bot-level route. */
  pickBudget?: number | null
  /** How many tasks the bot holds now across its projects; null is a host that answers no count. */
  holdsHeld?: number | null
  /** What a pick budget write is refused with, where the host refuses one. */
  budgetRefusal?: string | null
  /**
   * The bot's usage threshold, 50–100; null is Off, which is what a bot with no limit answers. A write
   * lands on this unless `thresholdAnswer` says what the host really keeps instead.
   */
  usageThreshold?: number | null
  /** What a usage threshold write is refused with, where the host refuses one. */
  thresholdRefusal?: string | null
  /** What a threshold write answers with, where the host holds something other than what was asked. */
  thresholdAnswer?: number | null
  /** The provider the host reports as its main model, which is whose account the usage is read for. */
  hostProvider?: string
  /** The account's usage windows as the host answers them; null is a provider with no windows. */
  windows?: { label: string; usedPercent: number }[] | null
  /** The window the host judged deciding, or null where none does — a balance with room is capacity. */
  deciding?: { label: string; usedPercent: number } | null
} = {}) {
  const library: Record<string, unknown>[] = [
    {
      id: "preset:one-run",
      name: "One run",
      preset: true,
      at: 1,
      stages: [workflowStage("Work", { ships: true })],
    },
    {
      id: "preset:staged",
      name: "Build · Test · Review · Summary",
      preset: true,
      at: 2,
      stages: [
        workflowStage("Build"),
        workflowStage("Test", { check: "gate" }),
        workflowStage("Review", { ships: true }),
        workflowStage("Summary"),
      ],
    },
  ]
  const calls: Call[] = []
  let chosen: string | null = workflow
  let words = prompt
  // The entry the Prompt was copied from: a pick names one, a hand edit names none.
  let source = promptId
  // The holds as the wire spells them: the oldest first, each with the stage its session is in.
  const held =
    holds === null
      ? null
      : holds.map((hold) => ({
          repo: hold.repo ?? "owner/repo",
          number: hold.number,
          title: hold.title ?? `Task ${hold.number}`,
          url: `https://x/${hold.number}`,
          created_at: "2026-10-01T00:00:00Z",
          stage: hold.stage ?? null,
          stage_name: hold.stage_name ?? null,
          stalled: hold.stalled ?? null,
        }))
  let count = pickCount
  // The bot's own budget: what the host holds, the host's default where it holds none, and what a
  // write leaves it at.
  let budget = pickBudget
  // The bot's threshold, the same way: what the host holds, and what a write leaves it at.
  let threshold = usageThreshold
  const botAnswer = () => ({
    object: "memento.afk.bot",
    pick_budget: budget ?? 5,
    usage_threshold: threshold,
    holds_held: holdsHeld ?? 0,
  })
  const answer = () => ({
    object: "memento.afk",
    project_id: projectId,
    on: true,
    reason: null,
    // The oldest hold is the task a host from before the pick count would name on its own.
    task:
      held === null
        ? { repo: "owner/repo", number: 338, title: "Pick a workflow", url: "https://x/338" }
        : (held[0] ?? null),
    ...(held === null ? {} : { holds: held }),
    ...(count === null ? {} : { pick_count: count }),
    ...(budget === null ? {} : { pick_budget: budget }),
    usage_threshold: threshold,
    ...(holdsHeld === null ? {} : { holds_held: holdsHeld }),
    refusal: null,
    build_skill: null,
    critique_skills: [],
    stage: held === null ? stage : (held[0]?.stage ?? null),
    stage_name: held === null ? stageName : (held[0]?.stage_name ?? null),
    workflow: library.find((entry) => entry.id === chosen),
    prompt: words,
    // Null where the words are the project's own: a host from before the library answers none.
    prompt_id: source,
  })
  const fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input))
    const method = (init?.method ?? "GET").toUpperCase()
    const body = init?.body ? JSON.parse(String(init.body)) : null
    calls.push({ method, path: url.pathname, body })
    if (url.pathname.endsWith("/plugins/memento/info")) return json({ name: "memento", features })
    // The host's main model, which is the account a pickup's first run spends: the Coding tab reads
    // the provider from here and asks the usage route for that account's windows.
    if (url.pathname.endsWith("/api/model/options"))
      return json({
        model: "test/model",
        provider: hostProvider,
        providers: [{ provider: hostProvider, authenticated: true, models: ["test/model"] }],
      })
    if (url.pathname.endsWith("/plugins/memento/usage"))
      return json({
        object: "memento.usage",
        provider: hostProvider,
        plan: null,
        windows: (windows ?? []).map((window) => ({
          label: window.label,
          used_percent: window.usedPercent,
          resets_at: null,
          detail: null,
          scope: "account",
        })),
        deciding: deciding
          ? {
              label: deciding.label,
              used_percent: deciding.usedPercent,
              resets_at: null,
              detail: null,
              scope: "account",
            }
          : null,
      })
    // The bot's own AFK route, beside the project's: no project segment, one write of its own.
    if (url.pathname.endsWith("/plugins/memento/afk")) {
      if (method === "POST" && typeof body?.pick_budget === "number") {
        if (budgetRefusal) return json({ error: { message: budgetRefusal } }, 400)
        budget = body.pick_budget
      }
      if (method === "POST" && "usage_threshold" in (body ?? {})) {
        if (thresholdRefusal) return json({ error: { message: thresholdRefusal } }, 400)
        threshold =
          thresholdAnswer !== undefined ? thresholdAnswer : (body.usage_threshold as number | null)
      }
      return json(botAnswer())
    }
    if (url.pathname.endsWith("/plugins/memento/skills"))
      return json({
        object: "list",
        data: [
          { name: "code-review", description: "Review a change.", category: "review" },
          { name: "plan", description: "Write a plan first.", category: null },
        ],
      })
    if (url.pathname.endsWith("/plugins/memento/workflows") && method === "GET")
      return json({ object: "memento.workflows", workflows: library })
    if (url.pathname.endsWith("/plugins/memento/workflows") && method === "POST") {
      library.push({
        id: `wf-${library.length}`,
        name: body?.name,
        preset: false,
        at: 9,
        stages: body?.stages,
      })
      return json({ object: "memento.workflows", workflows: library })
    }
    if (url.pathname.endsWith(`/projects/${projectId}/afk`) && method === "GET")
      return json(answer())
    if (url.pathname.endsWith(`/projects/${projectId}/afk`) && method === "POST") {
      if (typeof body?.workflow_id === "string") chosen = body.workflow_id
      if (typeof body?.prompt === "string") {
        if (promptRefusal) return json({ error: { message: promptRefusal } }, 400)
        // A Prompt and a pick are one choice between them, as the plugin writes them.
        words = body.prompt.trim() || DEFAULT_AFK_PROMPT
        chosen = null
        // The source rides the words: a pick names the entry it copied, and a plain write clears it.
        source = typeof body.prompt_id === "string" ? body.prompt_id : null
      }
      // A pick count is a write of its own, and one the host refuses writes nothing.
      if (typeof body?.pick_count === "number") {
        if (pickRefusal) return json({ error: { message: pickRefusal } }, 400)
        count = body.pick_count
      }
      return json(answer())
    }
    if (url.pathname.endsWith(`/projects/${projectId}/tasks`))
      return json({ repos: [], ready: [], claimed: [], blocked: [] })
    return json({ error: { message: `No route for ${method} ${url.pathname}` } }, 404)
  }
  /**
   * What the host holds now: the workflow a Prompt's write cleared, the words it answered, and the
   * entry those words were copied from (null for the project's own).
   */
  const state = () => ({ chosen, words, source })
  return { calls, fetch, library, state }
}

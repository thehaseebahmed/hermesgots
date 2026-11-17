// Imported by the generated service worker (vite.config.ts). A push names the chat (or routine, or
// project) and says what happened in it, never what was asked; the page it opens reads the rest from
// Hermes as usual. The kinds are the plugin's (plugin/push.py); src/lib/push-kinds.ts keeps where
// each one leads, and netlify/lib/fcm.ts says the same words on Android.

const WORDS = {
  approval: "Waiting for your approval",
  question: "You have a question waiting",
  plan: "The plan is ready for your review",
  run_done: "You have a new reply",
  run_failed: "The run stopped with an error",
  clone_failed: "This project couldn't be set up",
  routine_failed: "The last run failed",
  research_brief: "The brief is ready for your review",
  research_scope: "The scope is ready for your approval",
  research_done: "Your research is ready",
  research_failed: "The mission stopped with an error",
  routine_message: "A bot has a message",
  meeting_done: "Your meeting notes are ready",
  meeting_failed: "Meeting notes failed",
  room_input: "A room is waiting on you",
}

// When the plugin is older or couldn't find a name.
// Ids a host may still hold for the characters the posed ones replaced (`LEGACY_BOT_IDS` in
// src/components/bots.tsx, which this repeats: a worker can't import the app's modules).
const LEGACY_BOTS = {
  bolt: "bubble", ember: "pixel", custard: "wink", nimbus: "pip", sprout: "nova", twinkle: "sunny",
  bubbles: "byte", mochi: "lovey", cubby: "bubble", tri: "pixel", penny: "wink", hex: "byte",
  stella: "sunny", orbi: "pip", gem: "nova", bloom: "lovey",
}

const UNTITLED = {
  routine_failed: "A routine",
  routine_message: "A bot",
  clone_failed: "A project",
  research_brief: "A research mission",
  research_scope: "A research mission",
  research_done: "A research mission",
  research_failed: "A research mission",
  meeting_done: "A meeting",
  meeting_failed: "A meeting",
  room_input: "A room",
}

// What the push is about when it isn't a session.
const SCREENS = { routine_failed: "/routines", clone_failed: "/projects" }

// Where a tap lands: a screen of its own, a room's row, or the screen the push's id names. The same
// answer as `pushPath` in src/lib/push-kinds.ts, so the two move together.
function screenFor(kind, sessionId) {
  if (SCREENS[kind]) return SCREENS[kind]
  if (kind === "room_input")
    return sessionId ? `/c/${encodeURIComponent(sessionId)}` : "/"
  const screen = String(kind).startsWith("research_")
    ? "research"
    : String(kind).startsWith("meeting_")
      ? "meetings"
      : ""
  return screen ? `/${screen}${sessionId ? `/${encodeURIComponent(sessionId)}` : ""}` : undefined
}

self.addEventListener("push", (event) => {
  let data = {}
  try {
    data = event.data ? event.data.json() : {}
  } catch {
    // A message we can't read still gets a notification: browsers insist on one.
  }
  event.waitUntil(show(data))
})

async function show(data) {
  const sessionId = typeof data.session_id === "string" ? data.session_id : ""
  const screen = screenFor(data.kind, sessionId)
  // A newer push about the same thing replaces one still showing; what waits on the user is one
  // thing, whichever way.
  const group = ["approval", "question", "plan"].includes(data.kind) ? "session" : data.kind
  const tag = sessionId ? `${group || "session"}:${sessionId}` : "gots"
  const windows = await self.clients.matchAll({ type: "window", includeUncontrolled: true })
  const looking = windows.some((client) => client.visibilityState === "visible")
  const title =
    (typeof data.title === "string" && data.title.trim()) || UNTITLED[data.kind] || "Gots"
  const body =
    (typeof data.body === "string" && data.body.trim()) || WORDS[data.kind] || "Waiting for you"
  // The bot's own picture, badged with the Gots mark (`build-badges.mjs`), so it's plain which bot it
  // is. A host that still holds a retired id draws the character that replaced it.
  const bot = typeof data.bot === "string" && /^[a-z0-9-]{1,32}$/.test(data.bot) ? data.bot : ""
  // An approval's buttons, numbered by where they sit: a press names its number, and the worker
  // reads the link back out of the entry's own data. Chrome draws two, and a notice carries two.
  const actions = (Array.isArray(data.actions) ? data.actions : [])
    .filter((one) => one && typeof one.label === "string" && typeof one.url === "string")
    .slice(0, 2)
  const options = {
    body,
    tag,
    icon: bot ? `/bots/${LEGACY_BOTS[bot] || bot}/notify.png` : "/pwa-192x192.png",
    // Safari revokes a subscription that gets pushes without notifications, so a visible app still
    // shows one, silently. It is closed as soon as it is shown: Chrome counts it as delivered, and
    // nothing is left in the tray.
    silent: looking,
    data: { sessionId, screen, actions: actions.map((one) => one.url) },
  }
  if (actions.length) {
    // Chrome names a button by its id, so the index is the id and the label the title it draws.
    options.actions = actions.map((one, index) => ({ action: String(index), title: one.label }))
  }
  await self.registration.showNotification(title, options)
  if (looking) {
    // The browser may not list a notification in the same tick it was shown, so one retry.
    for (let attempt = 0; attempt < 2; attempt++) {
      const shown = await self.registration.getNotifications({ tag })
      if (shown.length) {
        for (const notification of shown) notification.close()
        break
      }
      await new Promise((resolve) => setTimeout(resolve, 300))
    }
  }
}

self.addEventListener("notificationclick", (event) => {
  event.notification.close()
  const { sessionId, screen, actions } = event.notification.data || {}
  // A button is an answer, not a visit: its press posts the one-shot link the notice minted and
  // leaves the tray, opening nothing. `no-cors` on purpose — the press needs no answer back, only
  // to land, and the host's CORS list is about the app's own reads, which a worker's press is not.
  const link = event.action ? (actions || [])[Number(event.action)] : undefined
  if (typeof link === "string" && /^https?:\/\//.test(link)) {
    event.waitUntil(answer(link))
    return
  }
  const path = screen || (sessionId ? `/s/${encodeURIComponent(sessionId)}` : "/")
  event.waitUntil(open(path))
})

async function answer(link) {
  try {
    await fetch(link, { method: "POST", mode: "no-cors" })
  } catch {
    // A press that can't land leaves nothing to say; the row is gone either way.
  }
}

async function open(path) {
  const windows = await self.clients.matchAll({ type: "window", includeUncontrolled: true })
  const client = windows[0]
  if (client) {
    try {
      await client.focus()
      await client.navigate(path)
      return
    } catch {
      // A window we don't control can't be navigated; open a new one.
    }
  }
  await self.clients.openWindow(path)
}

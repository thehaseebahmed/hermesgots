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
  pr_checks: "Checks are failing on the pull request",
  pr_merged: "Your pull request was merged",
  clone_failed: "This project couldn't be set up",
  routine_failed: "The last run failed",
  research_brief: "The brief is ready for your review",
  research_scope: "The scope is ready for your approval",
  research_done: "Your research is ready",
  research_failed: "The mission stopped with an error",
  afk_pr: "A task's pull request is ready to review",
  meeting_done: "Your meeting notes are ready",
  meeting_failed: "Meeting notes failed",
}

// When the plugin is older or couldn't find a name.
const UNTITLED = {
  routine_failed: "A routine",
  clone_failed: "A project",
  research_brief: "A research mission",
  research_scope: "A research mission",
  research_done: "A research mission",
  research_failed: "A research mission",
  meeting_done: "A meeting",
  meeting_failed: "A meeting",
}

// What the push is about when it isn't a session.
const SCREENS = { routine_failed: "/routines", clone_failed: "/projects" }

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
  const screen =
    SCREENS[data.kind] ||
    (String(data.kind).startsWith("research_")
      ? `/research${sessionId ? `/${encodeURIComponent(sessionId)}` : ""}`
      : String(data.kind).startsWith("meeting_")
        ? `/meetings${sessionId ? `/${encodeURIComponent(sessionId)}` : ""}`
        : undefined)
  // A newer push about the same thing replaces one still showing; what waits on the user is one
  // thing, whichever way.
  const group = ["approval", "question", "plan"].includes(data.kind) ? "session" : data.kind
  const tag = sessionId ? `${group || "session"}:${sessionId}` : "memento"
  const windows = await self.clients.matchAll({ type: "window", includeUncontrolled: true })
  const looking = windows.some((client) => client.visibilityState === "visible")
  const title =
    (typeof data.title === "string" && data.title.trim()) || UNTITLED[data.kind] || "Gots"
  const body =
    WORDS[data.kind] || "Waiting for you"
  // The bot's own picture, so it's plain which bot it is.
  const bot = typeof data.bot === "string" && /^[a-z0-9-]{1,32}$/.test(data.bot) ? data.bot : ""
  await self.registration.showNotification(title, {
    body,
    tag,
    icon: bot ? `/bots/${bot}.png` : "/pwa-192x192.png",
    // Safari revokes a subscription that gets pushes without notifications, so a visible app still
    // shows one, silently. It is closed as soon as it is shown: Chrome counts it as delivered, and
    // nothing is left in the tray.
    silent: looking,
    data: { sessionId, screen },
  })
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
  const { sessionId, screen } = event.notification.data || {}
  const path = screen || (sessionId ? `/s/${encodeURIComponent(sessionId)}` : "/")
  event.waitUntil(open(path))
})

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

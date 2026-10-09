// Imported by the generated service worker (vite.config.ts). A push says that a session waits on
// the user, or has news, never what it asked; the page it opens reads the rest from Hermes as usual.
// The kinds are the plugin's (plugin/push.py); src/lib/push-kinds.ts keeps where each one leads.

const WORDS = {
  approval: "Needs your approval",
  question: "Has a question for you",
  plan: "Plan ready for review",
  theseus: "Theseus is waiting for you",
  run_done: "Finished its work",
  run_failed: "Stopped with an error",
  pr_checks: "Pull request checks are failing",
  pr_merged: "Pull request merged",
  clone_failed: "A project couldn't be set up",
  routine_failed: "A routine failed",
}

// What the push is about when it isn't a session.
const SCREENS = { routine_failed: "/routines", clone_failed: "/code" }

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
  const screen = SCREENS[data.kind]
  // A newer push about the same thing replaces one still showing; what waits on the user is one
  // thing, whichever way.
  const group = ["approval", "question", "plan"].includes(data.kind) ? "session" : data.kind
  const tag = sessionId ? `${group || "session"}:${sessionId}` : "memento"
  const windows = await self.clients.matchAll({ type: "window", includeUncontrolled: true })
  const looking = windows.some((client) => client.visibilityState === "visible")
  await self.registration.showNotification("Memento", {
    body: WORDS[data.kind] || "Needs your input",
    tag,
    icon: "/pwa-192x192.png",
    // Safari revokes a subscription that gets pushes without notifications, so a visible app still
    // shows one, silently and only for a moment.
    silent: looking,
    data: { sessionId, screen },
  })
  if (looking) {
    await new Promise((resolve) => setTimeout(resolve, 3000))
    for (const notification of await self.registration.getNotifications({ tag })) notification.close()
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

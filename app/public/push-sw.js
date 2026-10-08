// Imported by the generated service worker (vite.config.ts). A push says that a session waits on
// the user, never what it asked; the page it opens reads the rest from Hermes as usual.

const WORDS = {
  approval: "Needs your approval",
  question: "Has a question for you",
  plan: "Plan ready for review",
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
  const tag = sessionId ? `session:${sessionId}` : "memento"
  const windows = await self.clients.matchAll({ type: "window", includeUncontrolled: true })
  const looking = windows.some((client) => client.visibilityState === "visible")
  await self.registration.showNotification("Memento", {
    body: WORDS[data.kind] || "Needs your input",
    tag,
    icon: "/pwa-192x192.png",
    // Safari revokes a subscription that gets pushes without notifications, so a visible app still
    // shows one, silently and only for a moment.
    silent: looking,
    data: { sessionId },
  })
  if (looking) {
    await new Promise((resolve) => setTimeout(resolve, 3000))
    for (const notification of await self.registration.getNotifications({ tag })) notification.close()
  }
}

self.addEventListener("notificationclick", (event) => {
  event.notification.close()
  const { sessionId } = event.notification.data || {}
  const path = sessionId ? `/s/${encodeURIComponent(sessionId)}` : "/"
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

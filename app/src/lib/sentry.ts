import type { BrowserOptions } from "@sentry/react"

import type { DiagReadFailure } from "@/lib/read-failure"

/**
 * Crash reporting to Sentry, off unless the build carries a DSN. `VITE_SENTRY_DSN` belongs to the
 * deployment, so a clone, the dev server and the tests report nothing — and the SDK is imported
 * only once there is somewhere to send, which keeps it out of the bundle a dev build serves.
 */

/** What a crash carries: where it happened, never the user's words or the bot's address. */
export function sentryOptions(dsn: string, environment: string, release: string): BrowserOptions {
  return {
    dsn,
    environment,
    release,
    // A crash report is not where the user's own words, their cookies or their bot's keys leave.
    dataCollection: { userInfo: false, cookies: false, httpHeaders: false, httpBodies: [] },
    // Crashes are the ask; traces would spend the plan's events on a screen nobody asked about.
    tracesSampleRate: 0,
    beforeSend(event) {
      // The URL names the chat open when the screen fell over, and a crash has no use for it.
      delete event.request?.url
      delete event.request?.cookies
      delete event.request?.headers
      return event
    },
    beforeBreadcrumb(breadcrumb) {
      // A request breadcrumb carries the bot's address and the session id in its URL.
      delete breadcrumb.data?.url
      return breadcrumb
    },
  }
}

let client: typeof import("@sentry/react") | undefined

/** Starts reporting if this build has a DSN. Calling it twice starts nothing twice. */
export async function startSentry() {
  const dsn = import.meta.env.VITE_SENTRY_DSN
  if (!dsn || client) return
  const Sentry = await import("@sentry/react")
  Sentry.init(sentryOptions(dsn, import.meta.env.MODE, __APP_VERSION__))
  client = Sentry
}

/** A screen that fell over, with the component stack the crash screen already shows. */
export function reportCrash(error: unknown, componentStack?: string | null) {
  if (!client) return
  client.captureException(
    error,
    componentStack ? { contexts: { react: { componentStack } } } : undefined,
  )
}

/**
 * A thread the app could not read — the block the pane can copy, sent as a warning: the screen
 * recovered from it, and the stack it carries is the only trace of why the read came back empty.
 */
export function reportUnreadThread(failure: DiagReadFailure) {
  client?.captureMessage("thread unread", {
    level: "warning",
    tags: { ending: failure.read.ended },
    extra: { read: failure },
  })
}

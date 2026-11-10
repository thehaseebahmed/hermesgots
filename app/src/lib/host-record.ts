import { useCallback, useEffect, useState } from "react"

import { connectionKey } from "@/lib/connection"
import type { Profile } from "@/lib/db"
import { READ_TIMEOUT_MS, WRITE_TIMEOUT_MS } from "@/lib/freshness"
import { hasPluginFeature } from "@/lib/hermes"
import { cachedHost, keepHost } from "@/lib/host-cache"
import { noteFailure } from "@/lib/report"

type Server = Pick<Profile, "baseUrl" | "apiKey">

export interface HostRoute<T> {
  /** The route's own name in the plugin's feature list: a plugin older than it has none. */
  feature: string
  label: string
  read: (server: Server, signal: AbortSignal) => Promise<T>
  write: (server: Server, value: T, signal: AbortSignal) => Promise<T>
}

type Held<T> = { supported: true; held: T } | { supported: false }

async function readHost<T>(server: Server, route: HostRoute<T>): Promise<Held<T>> {
  if (!(await hasPluginFeature(server, route.feature))) return { supported: false }
  const held = await route.read(server, AbortSignal.timeout(READ_TIMEOUT_MS))
  return { supported: true, held }
}

/** Reads a route once and keeps the answer for the page's first open (ADR 0132). */
export async function warmHostRecord<T>(server: Server, route: HostRoute<T>) {
  const held = await readHost(server, route)
  if (held.supported) await keepHost(server, route.feature, { value: held.held })
}

/**
 * Whether the host ran out of time rather than answering. The one failure that may still have
 * landed: a write the host refused hasn't.
 */
const timedOut = (error: unknown) => error instanceof DOMException && error.name === "TimeoutError"

export function useHostRecord<T>(
  profile: Server | null | undefined,
  route: HostRoute<T>,
  initial: T,
) {
  const baseUrl = profile?.baseUrl ?? ""
  const apiKey = profile?.apiKey ?? ""
  const key = connectionKey({ baseUrl, apiKey })
  const [state, setState] = useState<{ key: string; held: Held<T> }>()
  const [pending, setPending] = useState<{ key: string; value: T }>()
  const [copy, setCopy] = useState<{ key: string; value: T }>()

  useEffect(() => {
    if (!baseUrl) return
    let cancelled = false
    let landed = false
    // The field opens on the last answer this host gave this device (ADR 0132), shut until the
    // host's own answer lands.
    void cachedHost<{ value: T }>({ baseUrl, apiKey }, route.feature).then((held) => {
      if (!cancelled && !landed && held) setCopy({ key, value: held.value })
    })
    void readHost({ baseUrl, apiKey }, route)
      .then((held) => {
        landed = true
        if (cancelled) return
        setState({ key, held })
        if (held.supported) void keepHost({ baseUrl, apiKey }, route.feature, { value: held.held })
      })
      .catch((error: unknown) => {
        // A read that fails leaves the field off; the rest of the bot's settings still work.
        noteFailure(`Reading ${route.label}`, error)
        if (!cancelled) setState({ key, held: { supported: false } })
      })
    return () => {
      cancelled = true
    }
  }, [key, baseUrl, apiKey, route])

  const held = state?.key === key ? state.held : undefined
  const copyHere = !held && copy?.key === key ? copy : undefined
  const pendingHere = pending?.key === key ? pending : undefined

  const save = useCallback(
    async (value: T) => {
      setPending({ key, value })
      try {
        const stored = await route.write(
          { baseUrl, apiKey },
          value,
          AbortSignal.timeout(WRITE_TIMEOUT_MS),
        )
        setState({ key, held: { supported: true, held: stored } })
        void keepHost({ baseUrl, apiKey }, route.feature, { value: stored })
      } catch (error) {
        // A write that ran out of time may still have landed, so read what the host holds now: the
        // field must not sit on a value it may not have, and the control comes back either way.
        if (timedOut(error))
          await readHost({ baseUrl, apiKey }, route)
            .then((now) => setState({ key, held: now }))
            .catch((failed: unknown) => {
              noteFailure(`Reading ${route.label} after a write`, failed)
            })
        throw error
      } finally {
        setPending((now) => (now?.key === key ? undefined : now))
      }
    },
    [key, baseUrl, apiKey, route],
  )

  return {
    value: pendingHere
      ? pendingHere.value
      : held?.supported
        ? held.held
        : copyHere
          ? copyHere.value
          : initial,
    /**
     * Shown once the host has answered, or from the copy this device kept of its last answer: a bot
     * whose plugin predates the route shows nothing.
     */
    supported: Boolean(held?.supported) || Boolean(copyHere),
    /** The host's first read is over, whether it answered or failed. */
    settled: !baseUrl || state?.key === key,
    /** A write is on its way, or only the device's copy is drawn: the field greys out until the host's answer lands. */
    saving: pendingHere !== undefined || copyHere !== undefined,
    save,
  }
}

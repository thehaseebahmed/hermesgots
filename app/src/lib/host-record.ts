import { useCallback, useEffect, useState } from "react"

import { connectionKey } from "@/lib/connection"
import type { Profile } from "@/lib/db"
import { READ_TIMEOUT_MS, WRITE_TIMEOUT_MS } from "@/lib/freshness"
import { hasPluginFeature } from "@/lib/hermes"
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

  useEffect(() => {
    if (!baseUrl) return
    let cancelled = false
    void readHost({ baseUrl, apiKey }, route)
      .then((held) => {
        if (!cancelled) setState({ key, held })
      })
      .catch((error: unknown) => {
        // A read that fails leaves the field off; the rest of the bot's settings still work.
        noteFailure(`Reading ${route.label}`, error)
      })
    return () => {
      cancelled = true
    }
  }, [key, baseUrl, apiKey, route])

  const held = state?.key === key ? state.held : undefined
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
    value: pendingHere ? pendingHere.value : held?.supported ? held.held : initial,
    /** Shown only once the host has answered: a bot whose plugin predates the route shows nothing. */
    supported: Boolean(held?.supported),
    /** A write is on its way to the host: the field greys out until its answer lands. */
    saving: pendingHere !== undefined,
    save,
  }
}

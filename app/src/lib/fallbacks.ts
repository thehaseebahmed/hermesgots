import { useCallback, useEffect, useState } from "react"

import { connectionKey } from "@/lib/connection"
import type { Profile } from "@/lib/db"
import { READ_TIMEOUT_MS } from "@/lib/freshness"
import { getFallbackModels, hasPluginFeature, setFallbackModels, type Fallback } from "@/lib/hermes"
import { noteFailure } from "@/lib/report"

/** What a bot's host holds as its fallback chain, and whether it can hold one at all. */
export interface Fallbacks {
  fallbacks: Fallback[]
  /** A host whose Gots plugin offers the route; an older one can't hold fallbacks. */
  supported: boolean
}

type Server = Pick<Profile, "baseUrl" | "apiKey">

/**
 * A bot's fallback models, read from its host once the plugin says it has the route, and the way its
 * settings record new ones. `list` is what to show: the picks a write is putting on the host, until
 * the host's own answer lands, and `saving` whether such a write is on its way there.
 */
export function useFallbackModels(profile?: (Server & { id?: string }) | null) {
  const baseUrl = profile?.baseUrl ?? ""
  const apiKey = profile?.apiKey ?? ""
  const key = connectionKey({ baseUrl, apiKey })
  const [state, setState] = useState<{ key: string; held: Fallbacks }>()
  const [pending, setPending] = useState<{ key: string; fallbacks: Fallback[] }>()

  useEffect(() => {
    if (!baseUrl) return
    let cancelled = false
    void (async () => {
      if (!(await hasPluginFeature({ baseUrl, apiKey }, "fallbacks"))) {
        if (!cancelled) setState({ key, held: { fallbacks: [], supported: false } })
        return
      }
      try {
        const fallbacks = await getFallbackModels(
          { baseUrl, apiKey },
          AbortSignal.timeout(READ_TIMEOUT_MS),
        )
        if (!cancelled) setState({ key, held: { fallbacks, supported: true } })
      } catch (error) {
        // A read that fails leaves the rows off; the rest of the bot's settings still work.
        noteFailure("Reading the fallback models", error)
      }
    })()
    return () => {
      cancelled = true
    }
  }, [key, baseUrl, apiKey])

  const held = state?.key === key ? state.held : undefined
  const pendingHere = pending?.key === key ? pending.fallbacks : undefined

  const save = useCallback(
    async (fallbacks: Fallback[]) => {
      setPending({ key, fallbacks })
      try {
        const stored = await setFallbackModels({ baseUrl, apiKey }, fallbacks)
        setState({ key, held: { fallbacks: stored, supported: true } })
      } finally {
        setPending((now) => (now?.key === key ? undefined : now))
      }
    },
    [key, baseUrl, apiKey],
  )

  return {
    list: pendingHere ?? held?.fallbacks ?? [],
    /** Shown only once the host has answered: a bot whose plugin predates the route shows no rows. */
    supported: Boolean(held?.supported),
    /** A write is on its way to the host: the rows grey out until its answer lands. */
    saving: pending?.key === key,
    save,
  }
}

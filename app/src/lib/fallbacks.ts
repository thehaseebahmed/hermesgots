import { useCallback, useEffect, useState } from "react"

import { connectionKey } from "@/lib/connection"
import type { Profile } from "@/lib/db"
import { getFallbackModels, hasPluginFeature, setFallbackModels, type Fallback } from "@/lib/hermes"

/** What a bot's host holds as its fallback models, and whether it can hold any at all. */
export interface Fallbacks {
  fallbacks: Fallback[]
  /** A host whose Gots plugin offers the route; an older one can't record fallbacks. */
  supported: boolean
}

type Server = Pick<Profile, "baseUrl" | "apiKey">

/**
 * A bot's fallback models, read from its host once the plugin says it has the route, and the way its
 * settings record new ones. `list` is what to show: the picks a write is putting on the host, until
 * the host's own answer lands.
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
        const fallbacks = await getFallbackModels({ baseUrl, apiKey })
        if (!cancelled) setState({ key, held: { fallbacks, supported: true } })
      } catch {
        // A read that fails leaves the rows off; the rest of the bot's settings still work.
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
    save,
  }
}

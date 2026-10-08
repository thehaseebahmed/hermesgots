import { useEffect, useState } from "react"

import type { Profile } from "@/lib/db"
import { getModelInfo, type ModelInfo } from "@/lib/hermes"

const FRESH_MS = 60_000
const cache = new Map<string, { at: number; info: Promise<ModelInfo | null> }>()

/** The host's model and the models it's configured for, shared by every picker on its server. */
export function useModelInfo(profile?: Pick<Profile, "baseUrl" | "apiKey"> | null) {
  const baseUrl = profile?.baseUrl ?? ""
  const apiKey = profile?.apiKey ?? ""
  const key = `${baseUrl}\n${apiKey}`
  const [state, setState] = useState<{ key: string; info: ModelInfo | null }>()

  useEffect(() => {
    if (!baseUrl) return
    let cancelled = false
    let entry = cache.get(key)
    if (!entry || Date.now() - entry.at > FRESH_MS) {
      entry = { at: Date.now(), info: getModelInfo({ baseUrl, apiKey }) }
      cache.set(key, entry)
    }
    void entry.info.then((info) => {
      if (!cancelled) setState({ key, info })
    })
    return () => {
      cancelled = true
    }
  }, [key, baseUrl, apiKey])

  return state?.key === key ? state.info : undefined
}

/** A model id without its vendor prefix, for a pill: `anthropic/claude-sonnet-4.5` → `claude-sonnet-4.5`. */
export function shortModel(model: string) {
  return model.slice(model.lastIndexOf("/") + 1)
}

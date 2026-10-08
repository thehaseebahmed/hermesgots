import { useEffect, useState } from "react"

import { updateProfile, type ModelChoice, type Profile } from "@/lib/db"
import { getModelInfo, getPluginFeatures, setHostModel, type ModelInfo } from "@/lib/hermes"

const FRESH_MS = 60_000
const cache = new Map<string, { at: number; info: Promise<ModelInfo | null> }>()
const listeners = new Set<() => void>()

type Server = Pick<Profile, "baseUrl" | "apiKey">

function forget(profile: Server) {
  cache.delete(`${profile.baseUrl}\n${profile.apiKey}`)
  for (const listener of listeners) listener()
}

/**
 * Makes `choice` the bot's default model. Where the plugin can, that's the host's main model, so
 * Hermes's other surfaces and its dashboard run it too and the bot keeps no default of its own;
 * otherwise it stays the bot's own. Throws with Hermes's reason when the host refuses it.
 */
export async function setDefaultModel(profile: Profile, choice: ModelChoice | undefined) {
  if (choice) {
    const features = await getPluginFeatures(profile).catch((): string[] => [])
    if (features.includes("host_model")) {
      await setHostModel(profile, choice)
      forget(profile)
      choice = undefined
    }
  }
  await updateProfile(profile.id, { modelChoice: choice })
}

/** The host's model and the models it's configured for, shared by every picker on its server. */
export function useModelInfo(profile?: Server | null) {
  const baseUrl = profile?.baseUrl ?? ""
  const apiKey = profile?.apiKey ?? ""
  const key = `${baseUrl}\n${apiKey}`
  const [state, setState] = useState<{ key: string; info: ModelInfo | null }>()
  const [version, setVersion] = useState(0)

  useEffect(() => {
    const listener = () => setVersion((v) => v + 1)
    listeners.add(listener)
    return () => void listeners.delete(listener)
  }, [])

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
  }, [key, baseUrl, apiKey, version])

  return state?.key === key ? state.info : undefined
}

/** A model id without its vendor prefix, for a pill: `anthropic/claude-sonnet-4.5` → `claude-sonnet-4.5`. */
export function shortModel(model: string) {
  return model.slice(model.lastIndexOf("/") + 1)
}

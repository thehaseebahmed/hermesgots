import { useEffect, useState } from "react"

import { connectionKey } from "@/lib/connection"
import { db, updateProfile, type ModelChoice, type Profile } from "@/lib/db"
import { getModelInfo, getPluginFeatures, setHostModel, type ModelInfo } from "@/lib/hermes"

const FRESH_MS = 60_000
// A refresh probes every endpoint on the host, so a server whose endpoint stays empty isn't asked
// again on every open.
const REFRESH_MS = 10 * 60_000
const refreshed = new Map<string, number>()
const cache = new Map<string, { at: number; info: Promise<ModelInfo | null> }>()
const listeners = new Set<() => void>()

type Server = Pick<Profile, "baseUrl" | "apiKey">

function forget(profile: Server) {
  cache.delete(connectionKey(profile))
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

/**
 * Hermes lists a custom endpoint's models (an OpenRouter added under `custom_providers`, say) only
 * once it has probed that endpoint, which a plain read does just for the current provider. So an
 * endpoint that came back empty gets one refresh, after which Hermes's cache serves it.
 */
async function loadModelInfo(server: Server, key: string) {
  const info = await getModelInfo(server)
  if (!info?.unprobed || Date.now() - (refreshed.get(key) ?? 0) < REFRESH_MS) return info
  refreshed.set(key, Date.now())
  return (await getModelInfo(server, { refresh: true })) ?? info
}

/**
 * Remembers the model the host just reported on its bot, so a screen can show it while the host is
 * read again. Written through `updateProfile` so the change syncs, and only when it moved.
 */
async function rememberHostModel(profileId: string | undefined, info: ModelInfo | null) {
  const seen = info?.model ? { provider: info.provider ?? "", model: info.model } : undefined
  if (!seen || !profileId) return
  const saved = await db.profiles.get(profileId)
  const same =
    saved?.hostModel?.provider === seen.provider && saved?.hostModel?.model === seen.model
  if (!saved || same) return
  await updateProfile(profileId, { hostModel: seen })
}

/** The host's model and the models it's configured for, shared by every picker on its server. */
export function useModelInfo(profile?: (Server & { id?: string }) | null) {
  const baseUrl = profile?.baseUrl ?? ""
  const apiKey = profile?.apiKey ?? ""
  const profileId = profile?.id
  const key = connectionKey({ baseUrl, apiKey })
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
      entry = { at: Date.now(), info: loadModelInfo({ baseUrl, apiKey }, key) }
      cache.set(key, entry)
    }
    void entry.info.then(async (info) => {
      if (!cancelled) setState({ key, info })
      await rememberHostModel(profileId, info)
    })
    return () => {
      cancelled = true
    }
  }, [key, baseUrl, apiKey, version, profileId])

  return state?.key === key ? state.info : undefined
}

/** A model id without its vendor prefix, for a pill: `anthropic/claude-sonnet-4.5` → `claude-sonnet-4.5`. */
export function shortModel(model: string) {
  return model.slice(model.lastIndexOf("/") + 1)
}

/** `provider/model`, or the model alone when the host didn't name its provider. */
export function fullModel({ provider, model }: { provider?: string; model: string }) {
  return provider ? `${provider}/${model}` : model
}

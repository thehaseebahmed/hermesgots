import { useCallback, useEffect, useState } from "react"

import { connectionKey } from "@/lib/connection"
import { db, updateProfile } from "@/lib/db"
import { READ_TIMEOUT_MS, WRITE_TIMEOUT_MS } from "@/lib/freshness"
import { getSpeechSettings, setSpeechSettings } from "@/lib/hermes"
import { usePluginFeatureOn } from "@/lib/features"
import { noteFailure } from "@/lib/report"
import { readSpeech, SPEECH_MODEL, type SpeechPick, type SpeechSettings } from "@/lib/speech"

type Server = { baseUrl: string; apiKey: string }

export async function getSpeech(config: Server, signal?: AbortSignal): Promise<SpeechSettings> {
  return readSpeech(await getSpeechSettings(config, signal))
}

/** Keeps the model a host just reported on its bot, so the next screen shows it before it reads again. */
export async function rememberSpeech(id: string | undefined, model: string) {
  if (!id) return
  const saved = await db.profiles.get(id)
  if (!saved || saved.speechModel === model) return
  await updateProfile(id, { speechModel: model })
}

/** Whether a bot's speech read is still owed, and when it came back empty-handed. */
export type SpeechCheck = "checking" | "failed" | undefined

/**
 * What one bot's host hears on: the model it last reported for that bot, and whether this screen's
 * read is still owed. Gated on the feature `useSpeech` reads, so a host that can't report a model is
 * never asked for one (ADR 0060).
 */
export function useSpeechModel(
  profile?: (Server & { id?: string; speechModel?: string }) | null,
) {
  const baseUrl = profile?.baseUrl ?? ""
  const apiKey = profile?.apiKey ?? ""
  const id = profile?.id
  const key = connectionKey({ baseUrl, apiKey })
  const supported = usePluginFeatureOn({ baseUrl, apiKey }, SPEECH_MODEL)
  const [answer, setAnswer] = useState<{ key: string; model: string }>()
  const [settled, setSettled] = useState("")
  const [failed, setFailed] = useState("")

  useEffect(() => {
    if (!baseUrl || !supported) return
    let cancelled = false
    void getSpeech({ baseUrl, apiKey }, AbortSignal.timeout(READ_TIMEOUT_MS))
      .then((settings) => {
        if (!cancelled) {
          setAnswer({ key, model: settings.model })
          setSettled(key)
        }
        void rememberSpeech(id, settings.model)
      })
      .catch((error: unknown) => {
        noteFailure("Reading the host's speech model", error)
        if (!cancelled) setFailed(key)
      })
    return () => {
      cancelled = true
    }
  }, [key, id, baseUrl, apiKey, supported])

  const model = (answer?.key === key ? answer.model : profile?.speechModel) || undefined
  return {
    model,
    check: failed === key
      ? ("failed" as const)
      : model || settled === key || !supported
        ? undefined
        : ("checking" as const),
  }
}

export async function setSpeech(
  config: Server,
  patch: { model?: string; cleanup_model?: SpeechPick | null },
  signal?: AbortSignal,
): Promise<SpeechSettings> {
  return readSpeech(await setSpeechSettings(config, patch, signal))
}

export function useSpeech(profile?: (Server & { id?: string }) | null) {
  const baseUrl = profile?.baseUrl ?? ""
  const apiKey = profile?.apiKey ?? ""
  const id = profile?.id
  const key = connectionKey({ baseUrl, apiKey })
  const [state, setState] = useState<{ key: string; settings: SpeechSettings }>()
  const supported = usePluginFeatureOn({ baseUrl, apiKey }, SPEECH_MODEL)
  const [saving, setSaving] = useState(false)
  const [problem, setProblem] = useState<string | null>(null)

  useEffect(() => {
    if (!baseUrl || !supported) return
    let cancelled = false
    void getSpeech({ baseUrl, apiKey }, AbortSignal.timeout(READ_TIMEOUT_MS))
      .then((settings) => {
        if (!cancelled) setState({ key, settings })
        void rememberSpeech(id, settings.model)
      })
      .catch((error: unknown) => noteFailure("Reading the host's speech model", error))
    return () => {
      cancelled = true
    }
  }, [key, id, baseUrl, apiKey, supported])

  const write = useCallback(
    async (patch: { model?: string; cleanup_model?: SpeechPick | null }) => {
      setSaving(true)
      setProblem(null)
      try {
        const settings = await setSpeech(
          { baseUrl, apiKey },
          patch,
          AbortSignal.timeout(WRITE_TIMEOUT_MS),
        )
        setState({ key, settings })
        void rememberSpeech(id, settings.model)
        return true
      } catch (error) {
        setProblem(error instanceof Error ? error.message : String(error))
        return false
      } finally {
        setSaving(false)
      }
    },
    [key, id, baseUrl, apiKey],
  )

  return {
    settings: state?.key === key ? state.settings : undefined,
    supported,
    saving,
    problem,
    choose: (model: string) => write({ model }),
    chooseCleanup: (model: SpeechPick | null) => write({ cleanup_model: model }),
  }
}

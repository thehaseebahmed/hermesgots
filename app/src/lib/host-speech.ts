import { useCallback, useEffect, useState } from "react"

import { connectionKey } from "@/lib/connection"
import { db } from "@/lib/db"
import { READ_TIMEOUT_MS, WRITE_TIMEOUT_MS } from "@/lib/freshness"
import { getSpeechSettings, setSpeechSettings } from "@/lib/hermes"
import { usePluginFeatureOn } from "@/lib/features"
import { noteFailure } from "@/lib/report"
import { readSpeech, SPEECH_MODEL, type SpeechPick, type SpeechSettings } from "@/lib/speech"

type Server = { baseUrl: string; apiKey: string }

export async function getSpeech(config: Server, signal?: AbortSignal): Promise<SpeechSettings> {
  return readSpeech(await getSpeechSettings(config, signal))
}

/**
 * Keeps the model a host just reported on its bot, so the next screen shows it before it reads again.
 * Written without the bot's own clock: a read is no claim on when the bot last changed, and stamping
 * it here would let one device's read beat a rename made on another.
 */
export async function rememberSpeech(id: string | undefined, model: string) {
  if (!id) return
  const saved = await db.profiles.get(id)
  if (!saved || saved.speechModel === model) return
  await db.profiles.update(id, { speechModel: model })
}

/** Whether a bot's speech read is still owed, and when it came back empty-handed. */
export type SpeechCheck = "checking" | "failed" | undefined

export async function setSpeech(
  config: Server,
  patch: { model?: string; cleanup_model?: SpeechPick | null },
  signal?: AbortSignal,
): Promise<SpeechSettings> {
  return readSpeech(await setSpeechSettings(config, patch, signal))
}

/**
 * What a bot's host hears on, read once: its speech settings, the model it reported, and whether this
 * screen is still owed that answer. The Bots row and the Speech-to-text page both draw from here, so
 * one host is asked once by one path (ADR 0060).
 */
export function useSpeech(profile?: (Server & { id?: string; speechModel?: string }) | null) {
  const baseUrl = profile?.baseUrl ?? ""
  const apiKey = profile?.apiKey ?? ""
  const id = profile?.id
  const key = connectionKey({ baseUrl, apiKey })
  const [state, setState] = useState<{ key: string; settings: SpeechSettings }>()
  const [failed, setFailed] = useState("")
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
      .catch((error: unknown) => {
        noteFailure("Reading the host's speech model", error)
        if (!cancelled) setFailed(key)
      })
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

  const settled = state?.key === key
  // A bot's remembered model stands before the read comes back, so its row says what that host last
  // reported rather than "Checking…" on every mount.
  const model = (settled ? state?.settings.model : undefined) ?? profile?.speechModel ?? undefined
  const check: SpeechCheck =
    failed === key ? "failed" : model || settled || !supported || !baseUrl ? undefined : "checking"

  return {
    settings: settled ? state?.settings : undefined,
    model,
    check,
    supported,
    saving,
    problem,
    choose: (model: string) => write({ model }),
    chooseCleanup: (model: SpeechPick | null) => write({ cleanup_model: model }),
  }
}

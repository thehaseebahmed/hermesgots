import { useCallback, useEffect, useState } from "react"

import { connectionKey } from "@/lib/connection"
import { READ_TIMEOUT_MS, WRITE_TIMEOUT_MS } from "@/lib/freshness"
import { getPluginFeatureList, getSpeechSettings, setSpeechSettings } from "@/lib/hermes"
import { noteFailure } from "@/lib/report"
import { readSpeech, SPEECH_MODEL, type SpeechPick, type SpeechSettings } from "@/lib/speech"

type Server = { baseUrl: string; apiKey: string }

export async function getSpeech(config: Server, signal?: AbortSignal): Promise<SpeechSettings> {
  return readSpeech(await getSpeechSettings(config, signal))
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
  const key = connectionKey({ baseUrl, apiKey })
  const [state, setState] = useState<{ key: string; settings: SpeechSettings }>()
  const [supported, setSupported] = useState(false)
  const [saving, setSaving] = useState(false)
  const [problem, setProblem] = useState<string | null>(null)

  useEffect(() => {
    if (!baseUrl) return
    let cancelled = false
    void getPluginFeatureList({ baseUrl, apiKey }).then((features) => {
      if (cancelled || !features?.includes(SPEECH_MODEL)) return
      setSupported(true)
      return getSpeech({ baseUrl, apiKey }, AbortSignal.timeout(READ_TIMEOUT_MS))
        .then((settings) => {
          if (!cancelled) setState({ key, settings })
        })
        .catch((error: unknown) => noteFailure("Reading the host's speech model", error))
    })
    return () => {
      cancelled = true
    }
  }, [key, baseUrl, apiKey])

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
        return true
      } catch (error) {
        setProblem(error instanceof Error ? error.message : String(error))
        return false
      } finally {
        setSaving(false)
      }
    },
    [key, baseUrl, apiKey],
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

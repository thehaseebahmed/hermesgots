/**
 * The host's speech settings, made into calls: one read of `GET speech` per connection, and writes
 * that carry only the fields that moved. `speech.ts` is the shape and the words; this file is the
 * host.
 *
 * A plugin that predates the route advertises no `speech_model`, and `supported` stays false, so
 * the tab shows the bot's words alone rather than a picker that could only be refused. A refusal
 * is the plugin's own sentence — a model the host can't hear, a write it couldn't make — and is
 * shown beside the model still in place rather than replacing it with something half-written.
 */
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

/** Writes the fields that moved; the host answers the whole record, so nothing is guessed. */
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
        // The host's own sentence (a model it can't hear, a write it refused), not ours.
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

import { useCallback, useEffect, useState } from "react"

import { connectionKey } from "@/lib/connection"
import { db } from "@/lib/db"
import { PROBE_TIMEOUT_MS, READ_TIMEOUT_MS, WRITE_TIMEOUT_MS } from "@/lib/freshness"
import {
  getSpeechSettings,
  HermesError,
  probeSpeechSettings,
  setSpeechSettings,
  setSttSetting,
} from "@/lib/hermes"
import { usePluginFeatureAnswers } from "@/lib/features"
import { noteFailure } from "@/lib/report"
import {
  CLEANUP_LEVELS_FEATURE,
  HEARING_PROMPT_FEATURE,
  readSpeech,
  SPEECH_MODEL,
  SPEECH_PROBE_FEATURE,
  type CleanupLevel,
  type SpeechPick,
  type SpeechPatch,
  type SpeechSettings,
} from "@/lib/speech"
import { STT_SETTINGS, type SttValue } from "@/lib/stt-settings"

type Server = { baseUrl: string; apiKey: string }

export async function getSpeech(config: Server, signal?: AbortSignal): Promise<SpeechSettings> {
  return readSpeech(await getSpeechSettings(config, signal))
}

/** Asks the host to time its own hearing, and answers the record the picker's rows are drawn from. */
export async function probeSpeech(config: Server, signal?: AbortSignal): Promise<SpeechSettings> {
  return readSpeech(await probeSpeechSettings(config, signal))
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
  patch: SpeechPatch,
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
  // One read answers both questions — whether this host has the speech rows at all, and whether it
  // carries the rest of its speech settings, which a host too old for draws the model alone.
  const features = usePluginFeatureAnswers(
    { baseUrl, apiKey },
    {
      speech: SPEECH_MODEL,
      stt: STT_SETTINGS,
      levels: CLEANUP_LEVELS_FEATURE,
      hearing: HEARING_PROMPT_FEATURE,
      probe: SPEECH_PROBE_FEATURE,
    },
  )
  const supported = features.speech === "yes"
  const sttSupport = features.stt === "yes"
  // A plugin older than the four levels refuses both writes, so the page doesn't offer them at all.
  const levelsSupport = features.levels === "yes"
  const hearingSupport = features.hearing === "yes"
  // No probe is ever asked of a host that doesn't take one (ADR 0075).
  const probeSupport = features.probe === "yes"
  const [saving, setSaving] = useState(false)
  const [problem, setProblem] = useState<string | null>(null)
  // Kept with the connection they belong to, as `failed` is: another bot's probe is not this bot's.
  const [measuring, setMeasuring] = useState("")
  const [measureProblem, setMeasureProblem] = useState<{ key: string; message: string }>()

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

  /** One write's brackets: the page greys while it is out, and the host's words land on it if not. */
  const save = useCallback(async <T>(work: () => Promise<T>): Promise<T | undefined> => {
    setSaving(true)
    setProblem(null)
    try {
      return await work()
    } catch (error) {
      setProblem(error instanceof Error ? error.message : String(error))
      return undefined
    } finally {
      setSaving(false)
    }
  }, [])

  const write = useCallback(
    async (patch: SpeechPatch) => {
      const settings = await save(() =>
        setSpeech({ baseUrl, apiKey }, patch, AbortSignal.timeout(WRITE_TIMEOUT_MS)),
      )
      if (!settings) return false
      setState({ key, settings })
      // A fresh block is the host's word on its own measurement, so a probe that failed before it
      // has nothing left to say.
      setMeasureProblem(undefined)
      void rememberSpeech(id, settings.model)
      return true
    },
    [save, key, id, baseUrl, apiKey],
  )

  /** One speech setting, written on its own: the host answers the whole block it now holds. */
  const writeStt = useCallback(
    async (setting: string, value: SttValue) => {
      const stt = await save(() =>
        setSttSetting({ baseUrl, apiKey }, setting, value, AbortSignal.timeout(WRITE_TIMEOUT_MS)),
      )
      if (stt)
        setState((held) =>
          held?.key === key ? { key, settings: { ...held.settings, stt } } : held,
        )
      return Boolean(stt)
    },
    [save, key, baseUrl, apiKey],
  )

  /**
   * Asks the host to time its own hearing, once, where it still owes an answer: the picker's rows
   * are read from what comes back, and a host that has already measured is never asked again
   * (ADR 0075). A refusal is the host's own sentence, drawn under the rows rather than as a failure
   * of the page — a probe is an aid to a pick, never the pick itself.
   */
  const measure = useCallback(async () => {
    if (!probeSupport || measuring === key) return
    const held = state?.key === key ? state.settings : undefined
    // Nothing on disk is a host with nothing to time, and it already says so in `reason`.
    if (!held?.probe?.owed || held.probe.reason) return
    setMeasuring(key)
    setMeasureProblem(undefined)
    try {
      const settings = await probeSpeech(
        { baseUrl, apiKey },
        AbortSignal.timeout(PROBE_TIMEOUT_MS),
      )
      setState({ key, settings })
    } catch (error) {
      // Only an answer that came back is the host's to say: a status means it refused, and its own
      // sentence is drawn under the rows. A request that never landed is noted and left out of them,
      // since it says nothing about the models.
      if (error instanceof HermesError && error.status)
        setMeasureProblem({ key, message: error.message })
      else noteFailure("Measuring this host's speech models", error)
    } finally {
      setMeasuring((running) => (running === key ? "" : running))
    }
  }, [probeSupport, measuring, state, key, baseUrl, apiKey])

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
    /** Whether the host carries the rest of its speech settings on this page (ADR 0063). */
    stt: supported && sttSupport,
    /** Whether the host takes a cleanup level (ADR 0066). */
    levels: supported && levelsSupport,
    /** Whether the host takes a Hearing prompt for a take's decode (ADR 0067). */
    hearing: supported && hearingSupport,
    /** Whether the host times its own hearing and states it on the rows (ADR 0075). */
    probe: supported && probeSupport,
    /** Whether this bot's probe is out right now, so the picker says what it is waiting on. */
    measuring: measuring === key,
    /** This bot's own sentence for a probe it refused, drawn under the rows rather than as a page failure. */
    measureProblem: measureProblem?.key === key ? measureProblem.message : null,
    saving,
    problem,
    measure,
    choose: (model: string) => write({ model }),
    chooseCleanup: (model: SpeechPick | null) => write({ cleanup_model: model }),
    chooseLevel: (level: CleanupLevel) => write({ cleanup_level: level }),
    setHearing: (sent: boolean) => write({ hearing_prompt: sent }),
    writeStt,
  }
}

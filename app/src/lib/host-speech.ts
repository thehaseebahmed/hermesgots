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
  keepStt,
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

/** What a screen says where a bot's host never answered its speech read. */
export const READ_FAILED = "Couldn't read this bot's host."

/** The last speech answer a bot's host gave this device, or nothing where it never read one. */
export async function cachedSpeech(key: string): Promise<SpeechSettings | undefined> {
  try {
    const row = await db.speechCache.get(key)
    // Normalised on the way out like every other answer: a copy written by an older build is read
    // by this one's own rules, not drawn in whatever shape it was stored.
    return row ? readSpeech(row.speech) : undefined
  } catch (error) {
    noteFailure("Reading this device's copy of the host's speech settings", error)
    return undefined
  }
}

/**
 * Keeps a host's answer on this device, per bot: it is the copy the next open draws at once, before
 * a fresh read lands. Never synced — one connection's answer is drawn on that bot's screens alone.
 * Written as it arrives rather than compared first: a successful read is a fresh answer by
 * definition, and reading the row back to skip a put costs about what the put does.
 */
async function keepSpeech(config: Server, settings: SpeechSettings) {
  try {
    await db.speechCache.put({ key: connectionKey(config), speech: settings })
  } catch (error) {
    noteFailure("Keeping this host's speech settings", error)
  }
}

export async function getSpeech(config: Server, signal?: AbortSignal): Promise<SpeechSettings> {
  return kept(config, () => getSpeechSettings(config, signal))
}

/** Asks the host to time its own hearing, and answers the record the picker's rows are drawn from. */
export async function probeSpeech(config: Server, signal?: AbortSignal): Promise<SpeechSettings> {
  return kept(config, () => probeSpeechSettings(config, signal))
}

/** Whether a bot's speech read is still owed, and when it came back empty-handed. */
export type SpeechCheck = "checking" | "failed" | undefined

export async function setSpeech(
  config: Server,
  patch: SpeechPatch,
  signal?: AbortSignal,
): Promise<SpeechSettings> {
  return kept(config, () => setSpeechSettings(config, patch, signal))
}

/** One answer read and kept: every path that asks the host leaves this device its copy. */
async function kept(config: Server, ask: () => Promise<unknown>): Promise<SpeechSettings> {
  const settings = readSpeech(await ask())
  await keepSpeech(config, settings)
  return settings
}

/**
 * What a bot's host hears on, read once: its speech settings, the model it reported, and whether this
 * screen is still owed that answer. The Bots row and the Speech-to-text page both draw from here, so
 * one host is asked once by one path (ADR 0060).
 *
 * The page opens on the last answer this device read — `settings` is the fresh block once it lands,
 * and the cached one under a `stale` page until then, when every row is drawn muted and untappable
 * (ADR 0082). A write while nothing fresh has landed is refused here as well as in the page, so a
 * stale level or model never reaches the host.
 */
export function useSpeech(profile?: Server | null) {
  const baseUrl = profile?.baseUrl ?? ""
  const apiKey = profile?.apiKey ?? ""
  const key = connectionKey({ baseUrl, apiKey })
  const [state, setState] = useState<{ key: string; settings: SpeechSettings }>()
  const [cached, setCached] = useState<{ key: string; settings: SpeechSettings }>()
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
  // Whether the answer this hook holds is the host's own rather than this device's older copy: the
  // one question every guard below and the page's greying both ask (ADR 0082).
  const settled = state?.key === key

  // The copy this device last read, drawn before the read lands: a phone with no signal still shows
  // the page it answered five minutes ago rather than a blank one (ADR 0082).
  useEffect(() => {
    if (!key) return
    let cancelled = false
    void cachedSpeech(key).then((settings) => {
      if (!cancelled && settings) setCached({ key, settings })
    })
    return () => {
      cancelled = true
    }
  }, [key])

  useEffect(() => {
    if (!baseUrl || !supported) return
    let cancelled = false
    void getSpeech({ baseUrl, apiKey }, AbortSignal.timeout(READ_TIMEOUT_MS))
      .then((settings) => {
        if (!cancelled) setState({ key, settings })
      })
      .catch((error: unknown) => {
        noteFailure("Reading the host's speech model", error)
        if (cancelled) return
        setFailed(key)
        // The host's own sentence where it answered with one; our own where the request never landed.
        setProblem(
          error instanceof HermesError && error.status ? error.message : READ_FAILED,
        )
      })
    return () => {
      cancelled = true
    }
  }, [key, baseUrl, apiKey, supported])

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
      // Nothing fresh has landed, so what the page holds is this device's copy of an older answer:
      // writing it would send a value the host may have moved past (ADR 0082).
      if (!settled) return false
      const settings = await save(() =>
        setSpeech({ baseUrl, apiKey }, patch, AbortSignal.timeout(WRITE_TIMEOUT_MS)),
      )
      if (!settings) return false
      setState({ key, settings: keepStt(settings, state?.settings) })
      // A fresh block is the host's word on its own measurement, so a probe that failed before it
      // has nothing left to say.
      setMeasureProblem(undefined)
      return true
    },
    [save, settled, state, key, baseUrl, apiKey],
  )

  /** One speech setting, written on its own: the host answers the whole block it now holds. */
  const writeStt = useCallback(
    async (setting: string, value: SttValue) => {
      if (!settled) return false
      const stt = await save(() =>
        setSttSetting({ baseUrl, apiKey }, setting, value, AbortSignal.timeout(WRITE_TIMEOUT_MS)),
      )
      if (!stt) return false
      // The host's answer is the block it now holds, so the copy this device keeps moves with it:
      // the next open draws the write rather than the answer before it.
      const merged = state?.settings ? { ...state.settings, stt } : undefined
      if (merged) {
        setState({ key, settings: merged })
        await keepSpeech({ baseUrl, apiKey }, merged)
      }
      // Who hears a take is not in the `stt` block this answers with, so a provider pick is followed
      // by the read that names it: the page greys Cleanup on that route, and must not keep saying the
      // provider the bot has just left (ADR 0082).
      if (setting === "stt.provider") {
        const fresh = await save(() =>
          getSpeech({ baseUrl, apiKey }, AbortSignal.timeout(READ_TIMEOUT_MS)),
        )
        if (fresh) setState({ key, settings: fresh })
      }
      return true
    },
    [save, state, key, baseUrl, apiKey],
  )

  /**
   * Asks the host to time its own hearing, once, where it still owes an answer: the picker's rows
   * are read from what comes back, and a host that has already measured is never asked again
   * (ADR 0075). A refusal is the host's own sentence, drawn under the rows rather than as a failure
   * of the page — a probe is an aid to a pick, never the pick itself.
   */
  const measure = useCallback(async () => {
    if (!probeSupport || measuring === key) return
    // Nothing settled is nothing to measure: a page drawing this device's cached copy asks the host
    // nothing, so a stale block never puts it to work timing models for rows nobody may keep.
    const held = settled ? state?.settings : undefined
    // Nothing on disk is a host with nothing to time, and it already says so in `reason`.
    if (!held?.probe?.owed || held.probe.reason) return
    setMeasuring(key)
    setMeasureProblem(undefined)
    try {
      const settings = await probeSpeech(
        { baseUrl, apiKey },
        AbortSignal.timeout(PROBE_TIMEOUT_MS),
      )
      setState({ key, settings: keepStt(settings, state?.settings) })
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
  }, [probeSupport, measuring, settled, state, key, baseUrl, apiKey])

  // The last answer this device read stands until the fresh one lands, so the page opens on values
  // rather than on blank rows and the Bots line names the model that host last reported.
  const held = cached?.key === key ? cached.settings : undefined
  const settings = settled ? state?.settings : held
  const model = settings?.model || undefined
  const check: SpeechCheck =
    failed === key ? "failed" : model || settled || !supported || !baseUrl ? undefined : "checking"

  return {
    /** The host's fresh answer, or this device's cached one until a read lands (ADR 0082). */
    settings,
    /** Whether those values are the cached copy: every row is drawn muted and untappable. */
    stale: !settled && Boolean(held),
    /** Whether a read is out and this device holds nothing to draw in its place: a loader, no rows. */
    loading: supported && !settings && failed !== key,
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

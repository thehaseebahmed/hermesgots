/**
 * The Bubble: the one bot whose speech-to-text reaches other apps, mirrored to where the phone's own
 * service can read it, plus the two grants that let it run.
 *
 * The page is the only side that knows a bot's key, its vocabulary and how a multiplexed host spells
 * its profile, so every change of selection or connection is written out from here. The phone keeps
 * the last copy: a service that waited for the page to be alive could not start a take at all.
 */
import { Capacitor, registerPlugin } from "@capacitor/core"
import { useLiveQuery } from "dexie-react-hooks"
import { useEffect } from "react"

import { serverConfig } from "@/lib/connection"
import { getActiveProfile, listEnabledProfiles, listProfiles, type Profile } from "@/lib/db"
import { writeDictation } from "@/lib/dictations"
import {
  dictationLeavesHost,
  dictationWaitMs,
  primeDictationInfo,
  useDictationWaitMs,
} from "@/lib/dictation"
import { confirmedTake } from "@/lib/hermes"
import type { CleanupLevel } from "@/lib/speech"
import { pluginRoot } from "@/lib/host-url"
import { isNative } from "@/lib/native"
import { quietly } from "@/lib/report"
import { onReturn } from "@/lib/wake"

const PLUGIN = "Bubble"

export interface BubbleState {
  /** Whether the phone is running the Bubble. */
  enabled: boolean
  /** Whether the phone lets Gots draw over other apps. */
  overlay: boolean
  /** Whether the phone has switched the accessibility service on. */
  accessibility: boolean
}

/** A take the phone had nowhere to put, as the Bubble kept it for the log. */
export interface KeptTake {
  /** Quoted back once the row is written, so a handover is neither lost nor written twice. */
  id: string
  at: number
  profileId: string
  text: string
  heard: string
  ms: number
  level?: CleanupLevel
  cleaned?: boolean
  provider?: string
  model?: string
}

interface BubblePlugin {
  configure(options: {
    profileId: string
    root: string
    apiKey: string
    name: string
    vocabulary: string[]
    waitMs: number
    cloud: boolean
  }): Promise<void>
  requestMicrophone(): Promise<{ granted: boolean }>
  enable(): Promise<{ started: boolean; reason?: string }>
  disable(): Promise<void>
  state(): Promise<BubbleState>
  takeaways(): Promise<{ kept: KeptTake[] }>
  took(options: { ids: string[] }): Promise<void>
  openOverlay(): Promise<void>
  openAccessibility(): Promise<void>
}

const Bubble = registerPlugin<BubblePlugin>(PLUGIN)

/** The Android app only: a browser has no service, no window over other apps and no accessibility. */
export function bubbleAvailable() {
  return isNative && Capacitor.isPluginAvailable(PLUGIN)
}

export async function bubbleState(): Promise<BubbleState | undefined> {
  if (!bubbleAvailable()) return
  try {
    return await Bubble.state()
  } catch {
    return
  }
}

/**
 * Writes the bot a take would be heard by, with the host's own bound on its Confirm: the Bubble gives
 * up when the app would rather than at a number of its own.
 *
 * A write that fails is tried again and then said in the log, never swallowed: the phone would go on
 * dictating to the last bot it was told about — another host, another key, another vocabulary — and
 * every later take would land there without a word.
 */
export async function mirrorBubble(profile?: Profile) {
  if (!bubbleAvailable()) return
  const bot = profile ?? (await getActiveProfile())
  if (!bot) return
  const wait = dictationWaitMs(bot)
  const block = {
    profileId: bot.id,
    root: pluginRoot(bot.baseUrl),
    apiKey: bot.apiKey,
    name: bot.name,
    vocabulary: bot.vocabulary ?? [],
    // `-1` is "no host has been asked yet", which the phone tells apart from a bound of its own.
    waitMs: wait > 0 ? wait : -1,
    // A local model is warmed before a take's first Piece; a cloud one has nothing to warm.
    cloud: dictationLeavesHost(bot),
  }
  for (const attempt of [1, 2]) {
    try {
      await Bubble.configure(block)
      return
    } catch (error) {
      if (attempt === 2) quietly("mirroring the Bubble's bot")(error)
    }
  }
}

/**
 * The microphone, which is a runtime permission and not a screen of the phone's: asked for before the
 * Bubble starts, because a service of that type cannot be started without it.
 */
export async function requestBubbleMicrophone(): Promise<boolean> {
  if (!bubbleAvailable()) return false
  try {
    return (await Bubble.requestMicrophone())?.granted === true
  } catch {
    return false
  }
}

export async function enableBubble(): Promise<{ started: boolean; reason?: string }> {
  if (!bubbleAvailable()) return { started: false, reason: "platform" }
  try {
    return await Bubble.enable()
  } catch (error) {
    return { started: false, reason: error instanceof Error ? error.message : String(error) }
  }
}

export async function disableBubble() {
  if (!bubbleAvailable()) return
  await Bubble.disable().catch(quietly("turning the Bubble off"))
}

/**
 * Keeps the phone's copy of the bot in step with this device's selection, wherever the selection
 * moves — a bot's Main moves it as surely as the card does, so this hangs off the shell rather than
 * off the one screen that names it.
 */
export function useBubbleMirror() {
  const active = useLiveQuery(getActiveProfile, [])
  const baseUrl = active?.baseUrl ?? ""
  const apiKey = active?.apiKey ?? ""
  const wait = useDictationWaitMs(active)
  // The host's bound is read by the composer's own poll, which may not have run yet: asked for here,
  // and the fingerprint below carries its answer, so the phone is told again when it lands. Without
  // that, a cloud bot's take would be given up on at the floor while the host was still hearing it.
  useEffect(() => {
    if (baseUrl && apiKey) primeDictationInfo({ baseUrl, apiKey })
  }, [baseUrl, apiKey])
  const mirror = [active?.id ?? "", baseUrl, apiKey, (active?.vocabulary ?? []).join(","), String(wait)].join(
    "\u0000",
  )
  // `mirror` is the fields a take is heard with, and `mirrorBubble` reads the bot itself: a profile
  // object is replaced on every database write, and depending on the whole of it would rewrite the
  // same block for a change in none.
  useEffect(() => {
    if (!mirror) return
    void mirrorBubble()
  }, [mirror])
}

/**
 * A screen of the phone's, opened for a grant that only it can give: nothing to do in a browser, and
 * the reason as the message to show where the phone refused. The shape `native.ts` opens its own
 * screens with, because a third plugin will copy whichever of the two it reads first.
 */
async function openScreen(what: string, open: () => Promise<void>): Promise<string | undefined> {
  try {
    await open()
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error ?? "")
    return reason ? `Couldn't open ${what}: ${reason}` : `Couldn't open ${what}`
  }
}

/** The phone's own screen for drawing over other apps: the grant is the phone's to give. */
export async function openBubbleOverlay(): Promise<string | undefined> {
  if (!bubbleAvailable()) return
  return openScreen("the draw-over settings", () => Bubble.openOverlay())
}

/** The phone's own accessibility list, where the Bubble's service is switched on. */
export async function openBubbleAccessibility(): Promise<string | undefined> {
  if (!bubbleAvailable()) return
  return openScreen("the accessibility settings", () => Bubble.openAccessibility())
}

/**
 * Puts back what the phone could not type. A take whose words found no field is kept by the service
 * and handed over here, written as a **Dictation** so it is in the log the next time the app is
 * opened — which is what the toast that says so is promising.
 *
 * The phone is only told which takes were written. A row that failed stays on it and is handed over
 * again rather than being lost behind a promise the phone already made.
 */
export async function collectTakeaways(profiles?: Profile[]) {
  if (!bubbleAvailable()) return
  const kept = await Bubble.takeaways()
    .then((answer) => answer?.kept ?? [])
    .catch(() => [])
  if (!kept.length) return
  // Every bot, not only the enabled ones: a bot turned off still owns the takes it heard, and its
  // rows belong in the log under it rather than nowhere.
  const bots = profiles ?? (await listProfiles())
  const written: string[] = []
  for (const take of kept) {
    const bot = bots.find((one) => one.id === take.profileId)
    const landed = confirmedTake(take)
    // Nothing can be done with a take for a bot this device no longer has: it is dropped, and said
    // to be handled so the phone is not left holding it forever.
    if (!bot || !landed) {
      written.push(take.id)
      continue
    }
    const ok = await writeDictation(serverConfig(bot), landed)
      .then(() => true)
      .catch(quietly("writing a kept take"))
    if (ok) written.push(take.id)
  }
  if (written.length) await Bubble.took({ ids: written }).catch(quietly("acknowledging a kept take"))
}

/**
 * Drains the phone's kept takes when the app comes back to the screen and when a bot is added to it:
 * a take kept while Gots was warm is written before the next cold start, not at it.
 */
export function useBubbleTakeaways() {
  const profiles = useLiveQuery(listEnabledProfiles, [])
  const ids = (profiles ?? []).map((one) => one.id).join(",")
  // `ids` is every bot this device has: a profile object is replaced on any database write, and
  // re-draining the phone's handover for a change in none would drain it to nothing. The bot is read
  // again inside `collectTakeaways`, so a key that changed under the same ids is written with it.
  useEffect(() => {
    if (!ids) return
    void collectTakeaways()
  }, [ids])
  useEffect(() => {
    if (!ids) return
    return onReturn(() => void collectTakeaways())
  }, [ids])
}

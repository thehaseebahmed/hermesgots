import { useEffect, useState } from "react"

import { connectionKey } from "@/lib/connection"
import { cooldown, lacksRoute } from "@/lib/cooldown"
import { db } from "@/lib/db"
import { READ_TIMEOUT_MS } from "@/lib/freshness"
import { listSkills, type HermesConfig, type Skill } from "@/lib/hermes"
import { noteFailure } from "@/lib/report"

export type SkillsState =
  { status: "loading" } | { status: "ok"; skills: Skill[] } | { status: "error" }

// This page's answer, so a second open in the same page needs no read; the device keeps the row.
const memory = new Map<string, Skill[]>()
// One read per server at a time: an open while one is in flight joins it rather than asking again.
const inFlight = new Map<string, Promise<Skill[]>>()
// A plugin that answered 404 for the route: left alone for the window, as every other read of a
// route a plugin lacks is, so an older plugin is asked once per window instead of once per open.
const unsupported = cooldown()

async function readStored(key: string) {
  return (await db.skills.get(key))?.skills
}

/** An answer already held for a key wins over one being written under it. */
const keep = (
  current: { key: string; state: SkillsState } | null,
  key: string,
  state: SkillsState,
) => (current?.key === key ? current : { key, state })

/** Reads the profile's skills for this server and keeps them, unless the bot can't list them. */
function readSkills(config: HermesConfig, key: string): Promise<Skill[]> {
  const pending = inFlight.get(key)
  if (pending) return pending
  if (unsupported.cooling(key)) return Promise.resolve([])
  const request = (async () => {
    let skills: Skill[]
    try {
      skills = await listSkills(config, AbortSignal.timeout(READ_TIMEOUT_MS))
    } catch (error) {
      // A plugin with no skills route (an older one) has none to offer, so the menu shows the
      // commands alone; the plugin is left alone for a while and an upgrade fills the list in then.
      if (await lacksRoute(config, error, "skills")) {
        unsupported.start(key)
        return []
      }
      // A host that is away, busy or slow is not that answer: the cached list stands, and the
      // failure is noted like every other read the app carries on from.
      noteFailure("Reading the bot's skills", error)
      throw error
    }
    unsupported.clear(key)
    memory.set(key, skills)
    try {
      // Keeping the row is a favour to the next page load, not part of the answer: a Dexie failure
      // here (a blocked upgrade, a full quota) must not throw away what the host just sent.
      // Don't write what didn't change: a fresh row would wake anything reading this one.
      if (JSON.stringify(await readStored(key)) !== JSON.stringify(skills)) {
        await db.skills.put({ id: key, skills })
      }
    } catch (error) {
      noteFailure("Saving the bot's skills", error)
    }
    return skills
  })().finally(() => inFlight.delete(key))
  inFlight.set(key, request)
  return request
}

/**
 * The bot's skills as the device last knew them, read again in the background while `open`. What is
 * cached answers at once and stands if a read fails, so the menu never opens empty on a bot whose
 * host is away; a bot whose plugin has no skills route has none to show.
 */
export function useSkills(config: HermesConfig | null, open: boolean): SkillsState {
  // A bot the app reads plugin routes for at all: with no key, no route is read, as everywhere else.
  const key = config?.baseUrl.trim() && config.apiKey ? connectionKey(config) : ""
  const [result, setResult] = useState<{ key: string; state: SkillsState } | null>(null)
  const known = key ? memory.get(key) : undefined
  const state: SkillsState =
    result?.key === key
      ? result.state
      : known
        ? { status: "ok", skills: known }
        : key
          ? { status: "loading" }
          : { status: "ok", skills: [] }

  const baseUrl = config?.baseUrl
  const apiKey = config?.apiKey
  // A page that has never read this bot's skills starts from the device's copy of them, and only
  // while nothing else has answered for it yet.
  useEffect(() => {
    if (!key || memory.has(key)) return
    let cancelled = false
    void readStored(key).then((skills) => {
      // The host may have answered while this row was being read: keep the fresher list.
      if (!skills || cancelled || memory.has(key)) return
      memory.set(key, skills)
      setResult((current) => keep(current, key, { status: "ok", skills }))
    })
    return () => {
      cancelled = true
    }
  }, [key])

  useEffect(() => {
    if (!open || !baseUrl || !apiKey) return
    let cancelled = false
    readSkills({ baseUrl, apiKey }, key).then(
      (skills) =>
        !cancelled && setResult((current) => keep(current, key, { status: "ok", skills })),
      // A failed read leaves the cached list standing: nothing to report, nothing to lose.
      () => !cancelled && setResult((current) => keep(current, key, { status: "error" })),
    )
    return () => {
      cancelled = true
    }
  }, [open, key, baseUrl, apiKey])

  return state
}

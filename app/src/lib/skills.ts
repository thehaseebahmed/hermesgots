import { useEffect, useState } from "react"

import { connectionKey } from "@/lib/connection"
import { cooldown, lacksRoute } from "@/lib/cooldown"
import { db } from "@/lib/db"
import {
  usePluginFeatureAnswers,
  type PluginFeatureAnswer,
  type PluginServer,
} from "@/lib/features"
import { READ_TIMEOUT_MS, WRITE_TIMEOUT_MS } from "@/lib/freshness"
import {
  listSkills,
  removeSkill as removeFromHost,
  setSkillEnabled as writeSkillEnabled,
  type HermesConfig,
  type Skill,
} from "@/lib/hermes"
import { noteFailure } from "@/lib/report"
import { skillsState, type SkillsState } from "@/lib/skills-cache"

export type { SkillsState } from "@/lib/skills-cache"

/**
 * Every skills feature the tab asks its Bot's Host about, by the key it answers under: `list` gates
 * the tab itself, `write` gates each row's switch, because a Host can list a profile's skills without
 * the config write a switch is made of, and such a Host offers no switch rather than one whose every
 * tap could only fail (ADR 0044), `remove` gates the sheet's Remove, because a Host can switch a
 * skill without having either removal the two origins behind it need, and `view` gates a row's
 * sheet, because a Host can list skills without a lookup that answers for a switched-off one — the
 * row whose sheet matters most.
 */
export const SKILL_FEATURES = {
  list: "skills",
  write: "skills_write",
  remove: "skills_remove",
  view: "skills_view",
} as const

/** What each of those features this Bot's Host answered (see `PluginFeatureAnswer`). */
export type SkillFeatureAnswers = Record<keyof typeof SKILL_FEATURES, PluginFeatureAnswer>

/** What this Bot's plugin answered about its skills: `list`, `write` and `view`. */
export function useSkillFeatureAnswers(server: PluginServer): SkillFeatureAnswers {
  return usePluginFeatureAnswers(server, SKILL_FEATURES)
}

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

/**
 * Keeps one list of skills as the one every consumer reads: this page's `memory`, and the device's
 * row with it, so a write reaches the composer's `/` menu and the pickers at once (ADR 0044).
 *
 * Keeping the row is a favour to the next page load, not part of an answer: a Dexie failure here (a
 * blocked upgrade, a full quota) must not throw away what the Host just sent. And what didn't change
 * isn't written, because a fresh row would wake anything reading this one.
 */
async function keepSkills(key: string, skills: Skill[]) {
  memory.set(key, skills)
  try {
    if (JSON.stringify(await readStored(key)) !== JSON.stringify(skills)) {
      await db.skills.put({ id: key, skills })
    }
  } catch (error) {
    noteFailure("Saving the bot's skills", error)
  }
}

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
      // A host that is away, busy or slow is not that answer: the held list stands, and the failure
      // is noted like every other read the app carries on from.
      noteFailure("Reading the bot's skills", error)
      throw error
    }
    unsupported.clear(key)
    await keepSkills(key, skills)
    return skills
  })().finally(() => inFlight.delete(key))
  inFlight.set(key, request)
  return request
}

/**
 * Switches one skill on the Host, and takes the row the Host answers into the one list every
 * consumer reads — this page's `memory` and the device's row both — so the composer's `/` menu and
 * the skill pickers drop a skill switched off without waiting for a read (ADR 0044: one list
 * serves them all).
 *
 * A write the Host refuses is thrown, with the list as it was, so the screen shows the Host's own
 * sentence and the row it refused stays the row it was.
 */
async function switchSkill(config: HermesConfig, key: string, name: string, enabled: boolean) {
  const row = await writeSkillEnabled(config, name, enabled, AbortSignal.timeout(WRITE_TIMEOUT_MS))
  // The list this page holds, or the device's where the page hasn't read one yet: a list nobody has
  // read is no list to patch, and the next read fills it in from the Host.
  const held = memory.get(key) ?? (await readStored(key))
  if (!held) return
  await keepSkills(
    key,
    held.map((skill) => (skill.name === name ? { ...skill, ...row } : skill)),
  )
}

/**
 * Takes one skill off the Host, and replaces the one list every consumer reads — this page's
 * `memory` and the device's row both — with the list the Host says is left, so the tab, the
 * composer's `/` menu and the skill pickers all see the row gone at once (ADR 0044).
 *
 * A write the Host refuses is thrown, with the list as it was: the skill stays where it was, and the
 * screen shows the Host's own sentence.
 */
async function removeFromBot(config: HermesConfig, key: string, name: string) {
  await keepSkills(key, await removeFromHost(config, name, AbortSignal.timeout(WRITE_TIMEOUT_MS)))
}

/** The bot's skills as this page knows them, and the writes the tab makes over them. */
export type Skills = SkillsState & {
  /** Switches one skill on its Host; a refusal is thrown, leaving the list as it was. */
  setEnabled: (name: string, enabled: boolean) => Promise<void>
  /** Takes one skill off its Host; a refusal is thrown, leaving the list as it was. */
  remove: (name: string) => Promise<void>
}

/**
 * The bot's skills as this page last knew them, read again in the background while `open`: what the
 * page holds answers at once and a read that lands replaces it, so a skill installed a moment ago
 * shows without a reload, and a read that fails leaves it standing, so the menu never opens empty on
 * a bot whose host is away. A bot whose plugin has no skills route has none to show.
 *
 * `setEnabled` is the Skills tab's switch: the Host's row replaces that one row in the list every
 * consumer reads, so a skill switched off leaves the `/` menu and the pickers at once. `remove` is
 * its removal, and the Host's remaining list replaces the whole of it, so the row that went is gone
 * from every consumer too (ADR 0044: one list serves them all).
 */
export function useSkills(config: HermesConfig | null, open: boolean): Skills {
  // A bot the app reads plugin routes for at all: with no key, no route is read, as everywhere else.
  const key = config?.baseUrl.trim() && config.apiKey ? connectionKey(config) : ""
  // The read that has finished for this bot, as a fresh object each time: a read that lands must
  // render even when one has landed for this bot before, and the list itself lives in `memory`.
  const [settled, setSettled] = useState<{ key: string } | null>(null)
  const state = skillsState({
    key,
    known: key ? memory.get(key) : undefined,
    settled: settled?.key ?? null,
  })

  const baseUrl = config?.baseUrl
  const apiKey = config?.apiKey
  // A page that has never read this bot's skills starts from the device's copy of them. An answer
  // the page already holds is the fresher one, so the row only fills that gap, and a row that can't
  // be read is no worse than no row at all.
  useEffect(() => {
    if (!key || memory.has(key)) return
    let cancelled = false
    void readStored(key)
      .then((skills) => {
        if (cancelled || !skills || memory.has(key)) return
        memory.set(key, skills)
        setSettled({ key })
      })
      .catch((error: unknown) => noteFailure("Reading the bot's saved skills", error))
    return () => {
      cancelled = true
    }
  }, [key])

  // The read behind each open replaces what the page holds (and the device's row with it); a read
  // that fails leaves it standing, and all this records is that the read is over, so the menu stops
  // waiting on it and shows the commands alone.
  useEffect(() => {
    if (!open || !baseUrl || !apiKey) return
    let cancelled = false
    const done = () => {
      if (!cancelled) setSettled({ key })
    }
    readSkills({ baseUrl, apiKey }, key).then(done, done)
    return () => {
      cancelled = true
    }
  }, [open, key, baseUrl, apiKey])

  // Not memoized: it is handed to a row that is drawn from this render anyway, and the list it
  // writes is `memory`'s rather than a state of its own.
  const setEnabled = async (name: string, enabled: boolean) => {
    if (!baseUrl || !apiKey) return
    await switchSkill({ baseUrl, apiKey }, key, name, enabled)
    // A fresh object, so the row the write replaced is drawn even when it is the shape it had.
    setSettled({ key })
  }

  // Also not memoized, and for the same reason: the list it writes is `memory`'s, and the row that
  // goes is drawn from the render that asked for it.
  const remove = async (name: string) => {
    if (!baseUrl || !apiKey) return
    await removeFromBot({ baseUrl, apiKey }, key, name)
    setSettled({ key })
  }

  return { ...state, setEnabled, remove }
}

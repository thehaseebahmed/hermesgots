import { useCallback, useEffect, useState } from "react"

import { connectionKey } from "@/lib/connection"
import type { ModelChoice, Profile } from "@/lib/db"
import { READ_TIMEOUT_MS, WRITE_TIMEOUT_MS } from "@/lib/freshness"
import { getDelegationModel, hasPluginFeature, setDelegationModel } from "@/lib/hermes"
import { noteFailure } from "@/lib/report"

/** What a bot's host holds as the model its delegated tasks run on, and whether it holds one. */
export interface Delegation {
  /** The pick, or undefined when a delegated task inherits the bot's own model. */
  pick?: ModelChoice
  /** A host whose Gots plugin offers the route; an older one can't hold a pick. */
  supported: boolean
}

type Server = Pick<Profile, "baseUrl" | "apiKey">

/**
 * The host's own record, or nothing for a host whose plugin predates the route. A read that hangs
 * is treated as lost, since a dead connection can hang.
 */
async function readHost({ baseUrl, apiKey }: Server): Promise<Delegation> {
  if (!(await hasPluginFeature({ baseUrl, apiKey }, "delegation_model")))
    return { supported: false }
  const pick = await getDelegationModel({ baseUrl, apiKey }, AbortSignal.timeout(READ_TIMEOUT_MS))
  return { pick: pick ?? undefined, supported: true }
}

/**
 * Whether the host ran out of time rather than answering. The one failure that may still have
 * landed: a write the host refused hasn't.
 */
const timedOut = (error: unknown) => error instanceof DOMException && error.name === "TimeoutError"

/**
 * The model a bot's delegated tasks run on, read from its host once the plugin says it has the
 * route, and the way its settings record a new one. `pick` is what to show: the pick a write is
 * putting on the host, until the host's own answer lands, and `saving` whether such a write is on
 * its way there. Clearing it (undefined) puts every task back on the bot's own model.
 */
export function useDelegationModel(profile?: (Server & { id?: string }) | null) {
  const baseUrl = profile?.baseUrl ?? ""
  const apiKey = profile?.apiKey ?? ""
  const key = connectionKey({ baseUrl, apiKey })
  const [state, setState] = useState<{ key: string; held: Delegation }>()
  const [pending, setPending] = useState<{ key: string; pick?: ModelChoice }>()

  useEffect(() => {
    if (!baseUrl) return
    let cancelled = false
    void readHost({ baseUrl, apiKey })
      .then((held) => {
        if (!cancelled) setState({ key, held })
      })
      .catch((error: unknown) => {
        // A read that fails leaves the field off; the rest of the bot's settings still work.
        noteFailure("Reading the delegation model", error)
      })
    return () => {
      cancelled = true
    }
  }, [key, baseUrl, apiKey])

  const held = state?.key === key ? state.held : undefined
  const pendingHere = pending?.key === key ? pending : undefined

  const save = useCallback(
    async (pick: ModelChoice | undefined) => {
      setPending({ key, pick })
      try {
        const stored = await setDelegationModel(
          { baseUrl, apiKey },
          pick ?? null,
          AbortSignal.timeout(WRITE_TIMEOUT_MS),
        )
        setState({ key, held: { pick: stored ?? undefined, supported: true } })
      } catch (error) {
        // A write that ran out of time may still have landed, so read what the host holds now: the
        // field must not sit on a pick it may not have, and the control comes back either way.
        if (timedOut(error))
          await readHost({ baseUrl, apiKey })
            .then((now) => setState({ key, held: now }))
            .catch((failed: unknown) => {
              noteFailure("Reading the delegation model after a write", failed)
            })
        throw error
      } finally {
        setPending((now) => (now?.key === key ? undefined : now))
      }
    },
    [key, baseUrl, apiKey],
  )

  return {
    pick: pendingHere ? pendingHere.pick : held?.pick,
    /** Shown only once the host has answered: a bot whose plugin predates the route shows nothing. */
    supported: Boolean(held?.supported),
    /** A write is on its way to the host: the field greys out until its answer lands. */
    saving: pendingHere !== undefined,
    save,
  }
}

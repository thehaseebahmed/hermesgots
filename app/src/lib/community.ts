import { useEffect, useState } from "react"

import { callFunction, failure, functionUrl } from "@/lib/account"

/** The community leaderboard (`netlify/lib/community.ts`): joining, leaving and your own standing. */

export const LEADERBOARD_URL = "https://hermesgots.dev/community"

export interface Standing {
  login: string
  /** Tokens counted for the account over today, the last 7 days and the last 30. */
  totals: { today: number; week: number; month: number }
}

type Me = { joined: false } | ({ joined: true } & Standing)

const url = (route: string) => functionUrl("community", { route })

/** The last standing this device read, so the screen opens as it was rather than as off. */
const CACHE_KEY = "community:me"

function cached(): Me | null {
  try {
    const value = JSON.parse(localStorage.getItem(CACHE_KEY) ?? "null") as Me | null
    if (value?.joined === false) return value
    if (value?.joined === true && typeof value.totals?.today === "number") return value
    return null
  } catch {
    return null
  }
}

function remember(me: Me) {
  try {
    localStorage.setItem(CACHE_KEY, JSON.stringify(me))
  } catch {
    // Private windows and blocked storage just mean no cache.
  }
}

async function send(method: string, route: string) {
  const response = await callFunction(method, url(route))
  if (!response.ok) throw await failure(response)
  const me = (await response.json()) as Me
  remember(me)
  return me
}

export const joinCommunity = () => send("POST", "join")
export const leaveCommunity = () => send("POST", "leave")

/**
 * The account's standing: the device's last read at once, then the server's. Undefined only before
 * this device has ever read it; null when the read failed and there's nothing to show.
 */
export function useCommunity() {
  const [me, setMe] = useState<Me | null | undefined>(cached)
  useEffect(() => {
    let live = true
    send("GET", "me").then(
      (value) => live && setMe(value),
      () => live && setMe((previous) => previous ?? null),
    )
    return () => {
      live = false
    }
  }, [])
  return { me, setMe }
}

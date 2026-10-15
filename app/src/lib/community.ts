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

async function send(method: string, route: string) {
  const response = await callFunction(method, url(route))
  if (!response.ok) throw await failure(response)
  return (await response.json()) as Me
}

export const joinCommunity = () => send("POST", "join")
export const leaveCommunity = () => send("POST", "leave")

/** The account's standing; undefined while it loads, null when the read failed. */
export function useCommunity() {
  const [me, setMe] = useState<Me | null | undefined>(undefined)
  useEffect(() => {
    let live = true
    send("GET", "me").then(
      (value) => live && setMe(value),
      () => live && setMe(null),
    )
    return () => {
      live = false
    }
  }, [])
  return { me, setMe }
}

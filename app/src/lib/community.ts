import { useCallback, useEffect, useRef, useState } from "react"

import { callFunction, failure, functionUrl } from "@/lib/account"
import { tell } from "@/lib/tell"

/** The community leaderboard (`netlify/lib/community.ts`): joining, leaving and your own standing. */

export const LEADERBOARD_URL = "https://hermesgots.dev/community"

export interface Standing {
  login: string
  /** Tokens counted for the account over today, the last 7 days and the last 30. */
  totals: { today: number; week: number; month: number }
}

/**
 * `verified` is false for an account that joined before the device flow: its hosts still report,
 * but it is off the board until GitHub vouches for its username (docs/adr/0165).
 */
export type Me = { joined: false } | ({ joined: true; verified: boolean } & Standing)

/** A GitHub device flow the server opened: the code to type, and where. */
export interface Verify {
  userCode: string
  verificationUri: string
  /** Seconds the code has left. */
  expiresIn: number
  /** Seconds between two polls. */
  interval: number
}

/** What a join or a poll answers: where the account stands, and the flow when one is open. */
export type JoinAnswer = Me & { verify?: Verify; status?: "pending" | "expired" | "denied" }

const url = (route: string) => functionUrl("community", { route })

/** The last standing this device read, so the screen opens as it was rather than as off. */
const CACHE_KEY = "community:me"

function cached(): Me | null {
  try {
    const value = JSON.parse(localStorage.getItem(CACHE_KEY) ?? "null") as Me | null
    if (value?.joined === false) return value
    if (
      value?.joined === true &&
      typeof value.verified === "boolean" &&
      typeof value.totals?.today === "number"
    ) {
      return value
    }
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
  const { verify, status, ...me } = (await response.json()) as JoinAnswer
  remember(me as Me)
  return { ...me, verify, status } as JoinAnswer
}

/** Joins, or opens GitHub's device flow when the account hasn't proved its username yet. */
export const joinCommunity = () => send("POST", "join")
/** Asks whether the code was approved; `status` says why not where it wasn't. */
export const pollJoin = () => send("POST", "join-poll")
export const leaveCommunity = () => send("POST", "leave")

/** Whether the account is on the public board, which only a username GitHub vouched for is. */
export const onBoard = (me: Me | null | undefined): me is Extract<Me, { joined: true }> =>
  me?.joined === true && me.verified

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

/**
 * Joining through GitHub's device flow: `start` asks to join and opens a flow when the username
 * isn't proved yet, and while one is open this polls at GitHub's own pace until it is approved,
 * refused or out of time. The username is the one GitHub answers for (docs/adr/0165).
 */
export function useJoin(setMe: (me: Me) => void, onJoined?: () => void) {
  const [verify, setVerify] = useState<Verify | null>(null)
  const joined = useRef(onJoined)
  useEffect(() => {
    joined.current = onJoined
  })

  useEffect(() => {
    if (!verify) return
    let live = true
    let timer: ReturnType<typeof setTimeout>
    const tick = async () => {
      try {
        const answer = await pollJoin()
        if (!live) return
        setMe(answer)
        if (answer.status === "pending") {
          timer = setTimeout(tick, verify.interval * 1000)
          return
        }
        setVerify(null)
        if (onBoard(answer)) joined.current?.()
        if (answer.status === "expired") tell.error("The GitHub code ran out. Try again.")
        if (answer.status === "denied")
          tell.error("GitHub wasn't allowed to confirm your username.")
      } catch {
        if (!live) return
        setVerify(null)
        tell.error("Couldn't check with GitHub. Try again.")
      }
    }
    timer = setTimeout(tick, verify.interval * 1000)
    return () => {
      live = false
      clearTimeout(timer)
    }
  }, [verify, setMe])

  const start = async () => {
    const answer = await joinCommunity()
    setMe(answer)
    setVerify(answer.verify ?? null)
    return answer
  }

  const cancel = useCallback(() => setVerify(null), [])
  return { verify, start, cancel }
}

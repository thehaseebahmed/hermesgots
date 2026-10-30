import { useEffect, useState } from "react"

import { getSettings } from "@/lib/db"
import { progressRemindersShown } from "@/lib/progress-reminder"

/**
 * Whether a thread may draw progress reminders: this device's *Show progress reminders*, read once
 * where a reply actually holds one, so a chat nothing fired in costs no read at all (ADR 0068). A
 * thread already on screen keeps the answer it opened with — the switch reaches the next open, and
 * never rewrites the thread being read — which is the same rule chat-next's page asks.
 */
export function useRemindersShown(needed: boolean) {
  const [shown, setShown] = useState(false)
  useEffect(() => {
    if (!needed) return
    let here = true
    void getSettings()
      .then((settings) => {
        if (here) setShown(progressRemindersShown(settings))
      })
      .catch(() => undefined)
    return () => {
      here = false
    }
  }, [needed])
  return needed && shown
}

import { useLiveQuery } from "dexie-react-hooks"

import { botLabels } from "@/lib/bot-name"
import { listProfiles } from "@/lib/db"

/**
 * Every bot on this device, labelled against every other one (ADR 0149). One peer set for every list
 * on purpose: a list that labelled against only the bots it draws would name one bot two ways — a bot
 * whose namesake is turned off reads bare here and with its host there.
 */
export function useBotLabels() {
  return botLabels(useLiveQuery(listProfiles, []) ?? [])
}

/**
 * The lead a chat-shaped screen draws and the press it answers (ADR 0144): which bot's list its row
 * stands in, what its bar leads with, and what Android's press does there.
 *
 * A bot's chat, a room and a routine's run are all rows of a bot's list, so all three ask the same
 * three questions — is my list a real screen here, is it already on screen beside me, and where does
 * the press go — and answered them separately until this module. What a screen still decides for
 * itself is which bot carries it (a chat's own, a room's `state.bot`), whether a list can stand
 * beside it at all (a room's cannot), and the words its control wears.
 */
import { useCallback, useEffect, useRef } from "react"

import { BackButton } from "@/components/back-button"
import { botChatsPath } from "@/lib/bot-tabs"
import { useLegacyChat } from "@/lib/legacy-chat"
import { useNav } from "@/lib/nav"
import { setBackGuard } from "@/lib/native"
import { useSplit } from "@/lib/pane"

/**
 * What a press does where nothing stands behind the screen: `back` steps to whatever opened it and
 * leaves the app at its entry, and `list` always steps onto the list, which is a room's and a run's
 * answer — the screen they were opened from is that list.
 */
type Press = "back" | "list"

export function useChatLead({
  bot,
  beside,
  press = "back",
  label,
  underCode = false,
  leave,
}: {
  /** The bot whose list this screen's row stands in, where one holds it. */
  bot: string | undefined
  /** Whether that list is on screen beside this one; the split width's answer by default. */
  beside?: boolean
  press?: Press
  /** What the bar's control says. A screen whose bar leads with the drawer passes none. */
  label?: string
  /** A project session under Code leads back to Code rather than to any list. */
  underCode?: boolean
  /** Where that control goes; the session's own way out of Code. */
  leave?: () => void
}) {
  const legacy = useLegacyChat()
  const split = useSplit()
  const { back, backToList } = useNav()
  // The legacy layout has no bot's screen at all, so nothing of the list is drawn there.
  const list = legacy === false && bot ? botChatsPath(bot) : undefined
  const besideList = (beside ?? split) && Boolean(list)
  const ontoList = useCallback(() => {
    if (list) backToList(list)
  }, [list, backToList])
  // `useNav` hands back a fresh move whenever the address does, while the guard must not re-register
  // with it: the guard reads the move it was made with.
  const step = useRef(ontoList)
  useEffect(() => {
    step.current = ontoList
  }, [ontoList])
  const listed = useCallback(() => {
    if (!list) return false
    step.current()
    return true
  }, [list])
  useEffect(() => {
    if (!list) return
    return setBackGuard(press === "list" ? listed : back())
  }, [list, press, listed, back])
  const leading = underCode ? (
    <BackButton label="Back to Code" onClick={() => void leave?.()} floating />
  ) : besideList || !list || !label ? undefined : (
    <BackButton label={label} onClick={() => ontoList()} floating />
  )
  return {
    /** The bot's list, where it does not already stand beside this screen: what the bar opens. */
    listPath: besideList ? undefined : list,
    /** The same address whether or not the list is beside: where a screen that deletes itself goes. */
    list,
    /** Steps back onto that list, carrying the marker a list reads as the reader's own step. */
    ontoList,
    leading,
  }
}

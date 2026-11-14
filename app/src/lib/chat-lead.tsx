/**
 * The lead a chat-shaped screen draws and the press it answers (ADR 0144, ADR 0154): which bot's list
 * its row stands in, what its bar's corner carries, and what the platform's back does there.
 *
 * A bot's chat, a room, a routine's run and the routines screen are all screens of one bot, so all
 * four ask the same three questions — is my list a real screen here, is it already on screen beside
 * me, and what does the press do — and answered them separately until this module. What a screen still
 * decides for itself is which bot carries it (a chat's own, a room's `state.bot`); the words its
 * control wears come from here, named for the list it lands on, so four screens cannot word one move
 * four ways.
 */
import { useCallback, useEffect, useRef } from "react"

import { BackButton } from "@/components/back-button"
import { botChatsPath } from "@/lib/bot-tabs"
import { useLegacyChat } from "@/lib/legacy-chat"
import { useNav } from "@/lib/nav"
import { setBackGuard } from "@/lib/native"
import { useSplit } from "@/lib/pane"
import { useBotLabels } from "@/lib/use-bot-labels"

/** What the control says where this device cannot name the bot whose list it lands. */
const UNNAMED = "Back to chats"

export function useChatLead({
  bot,
  beside,
  underCode = false,
  leave,
}: {
  /** The bot whose list this screen's row stands in, where one holds it. */
  bot: string | undefined
  /** Whether that list is on screen beside this one; the split width's answer by default. */
  beside?: boolean
  /** A project session under Code leads back to Code rather than to any list. */
  underCode?: boolean
  /** Where that control goes; the session's own way out of Code. */
  leave?: () => void
}) {
  const legacy = useLegacyChat()
  const split = useSplit()
  const { up } = useNav()
  // The label this device's lists give that bot, so a bot whose namesake answers elsewhere is told
  // apart in this control too (ADR 0149). Read off the one map every list draws from rather than from
  // the bot's own row: the screens this leads already hold that row, and a second read of it would
  // leave the corner empty until it landed.
  const named = useBotLabels().get(bot ?? "")
  // The legacy layout has no bot's screen at all, so nothing of the list is drawn there.
  const list = legacy === false && bot ? botChatsPath(bot) : undefined
  const besideList = (beside ?? split) && Boolean(list)
  const ontoList = useCallback(() => {
    if (list) up(list)
  }, [list, up])
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
  // A conversation — and the routines screen — answer the platform's back with the list, whether the
  // list opened them or the reader arrived at the address another way: the press's move is the corner
  // control's, so the two can never disagree about where back goes.
  useEffect(() => {
    if (!list) return
    return setBackGuard(listed)
  }, [list, listed])
  // A Code session's way out is the one leading control: it leads back to Code, which is a place a
  // screen opened, not a list its row stands in.
  const leading = underCode ? (
    <BackButton label="Back to Code" onClick={() => void leave?.()} floating />
  ) : undefined
  // The bar's corner, at every width: the list beside a conversation is a lane of the same screen, so
  // the control stands there too rather than letting each width guess where its way back is.
  const words = named ? `Back to ${named}` : UNNAMED
  const wayBack = list ? <BackButton label={words} onClick={() => ontoList()} floating /> : undefined
  return {
    /** Whether the list stands beside this screen, so its bar drops the bot's face. */
    besideList,
    /** The list's address, where one holds this screen: what a screen that deletes itself steps onto. */
    list,
    /** Steps back onto that list, which is what a room's and a run's control answers with. */
    ontoList,
    /** The bar's corner: the control that steps onto that list, named for where it lands. */
    back: wayBack,
    /** A Code session's leading control, where this screen is one: nothing leads a bot's conversation. */
    leading,
  }
}

/**
 * The lead a chat-shaped screen draws and the press it answers (ADR 0144, ADR 0154): which bot's list
 * its row stands in, what its bar leads with, and what the platform's back does there.
 *
 * A bot's chat, a room, a routine's run and the routines screen are all screens of one bot, so all
 * four ask the same three questions — is my list a real screen here, is it already on screen beside
 * me, and what does the press do — and answered them separately until this module. What a screen still
 * decides for itself is which bot carries it (a chat's own, a room's `state.bot`); the words its
 * control wears come from here, named for the list it lands on, so four screens cannot word one move
 * four ways.
 *
 * The bot's **Main** is the one screen of a bot's that leads nowhere: it is what the bot's own entry
 * opens onto (G1), so it names no list and draws no way back from it.
 */
import { useCallback, useEffect, useRef } from "react"

import { BackButton } from "@/components/back-button"
import { botChatsPath, botMainPath } from "@/lib/bot-tabs"
import { useChatLayout, type ChatLayout } from "@/lib/chat-layout"
import { useNav } from "@/lib/nav"
import { setBackGuard } from "@/lib/native"
import { useSplit } from "@/lib/pane"
import { useBotLabels } from "@/lib/use-bot-labels"

/** What the control says where this device cannot name the bot whose list it lands. */
export const UNNAMED = "Back to chats"

/**
 * The list a layout draws a bot's chats on: the new UX's has an address of its own under the bot, and
 * the flat layout's is the bot's own address, because that layout's list is the bot's screen.
 */
export function listPathOf(layout: ChatLayout, bot: string) {
  return layout === "flat" ? botMainPath(bot) : botChatsPath(bot)
}

export function useChatLead({
  bot,
  main = false,
  beside,
  underCode = false,
  leave,
}: {
  /** The bot whose list this screen's row stands in, where one holds it. */
  bot: string | undefined
  /**
   * Whether this screen is that bot's **Main**, which leads back to nothing: Main is where a bot
   * opens, so there is no list behind it and no control onto one.
   */
  main?: boolean
  /** Whether that list is on screen beside this one; the split width's answer by default. */
  beside?: boolean
  /** A project session under Code leads back to Code rather than to any list. */
  underCode?: boolean
  /** Where that control goes; the session's own way out of Code. */
  leave?: () => void
}) {
  const layout = useChatLayout()
  const split = useSplit()
  const { up } = useNav()
  // The label this device's lists give that bot, so a bot whose namesake answers elsewhere is told
  // apart in this control too (ADR 0149). Read off the one map every list draws from rather than from
  // the bot's own row: the screens this leads already hold that row, and a second read of it would
  // leave the row's first slot empty until it landed.
  const named = useBotLabels().get(bot ?? "")
  // The flat layout's list is the bot's own address and the new UX's has one of its own, so a chat's
  // way back is the list its layout draws. Main is the bot's entry rather than a rung above it, so it
  // names no list either; a device whose settings have not answered draws the control once they do.
  const list = bot && !main && layout ? listPathOf(layout, bot) : undefined
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
  // list opened them or the reader arrived at the address another way: the press's move is the leading
  // control's, so the two can never disagree about where back goes.
  useEffect(() => {
    if (!list) return
    return setBackGuard(listed)
  }, [list, listed])
  // A Code session's way out leads to Code, which is a place a screen opened, not a list its row
  // stands in; every other screen of a bot leads back to the list its row stands in.
  const words = named ? `Back to ${named}` : UNNAMED
  const leading = underCode ? (
    <BackButton label="Back to Code" onClick={() => void leave?.()} floating />
  ) : list ? (
    <BackButton label={words} onClick={ontoList} floating />
  ) : undefined
  return {
    /** Whether the list stands beside this screen, so its bar drops the bot's face. */
    besideList,
    /** The list's address, where one holds this screen: what a screen that deletes itself steps onto. */
    list,
    /** Steps back onto that list, which is what a room's and a run's control answers with. */
    ontoList,
    /** The bar's leading control: the way back onto that list, or to Code for a session under it. */
    leading,
  }
}

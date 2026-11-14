/**
 * The lead a chat-shaped screen draws and the press it answers (ADR 0144): which bot's list its row
 * stands in, what its bar's corner carries, and what Android's press does there.
 *
 * A bot's chat, a room and a routine's run are all rows of a bot's list, so all three ask the same
 * three questions — is my list a real screen here, is it already on screen beside me, and where does
 * the press go — and answered them separately until this module. What a screen still decides for
 * itself is which bot carries it (a chat's own, a room's `state.bot`); the words its control wears
 * come from here, named for the list it lands on, so three screens cannot word one move three ways.
 */
import { useCallback, useEffect, useRef } from "react"
import { useLiveQuery } from "dexie-react-hooks"

import { BackButton } from "@/components/back-button"
import { labelOf } from "@/lib/bot-name"
import { botChatsPath } from "@/lib/bot-tabs"
import { db } from "@/lib/db"
import { useLegacyChat } from "@/lib/legacy-chat"
import { useNav } from "@/lib/nav"
import { setBackGuard } from "@/lib/native"
import { useSplit } from "@/lib/pane"
import { useBotLabels } from "@/lib/use-bot-labels"

/**
 * What a press does where nothing stands behind the screen: `back` steps to whatever opened it and
 * leaves the app at its entry, and `list` always steps onto the list — a bot's conversation, a room
 * and a routine's run are all one rung off that list, so the press's move is the corner control's
 * wherever the screen was opened from.
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
  /** What the bar's corner says, for a screen that must word it differently from `Back to <bot>`. */
  label?: string
  /** A project session under Code leads back to Code rather than to any list. */
  underCode?: boolean
  /** Where that control goes; the session's own way out of Code. */
  leave?: () => void
}) {
  const legacy = useLegacyChat()
  const split = useSplit()
  const { back, up } = useNav()
  const labels = useBotLabels()
  // The bot whose list this screen is a row of, read for the name its control wears: the label every
  // list gives that bot, so a bot whose namesake answers elsewhere is told apart here too (ADR 0149).
  const botRow = useLiveQuery(() => (bot ? db.profiles.get(bot) : undefined), [bot])
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
  useEffect(() => {
    if (!list) return
    return setBackGuard(press === "list" ? listed : back())
  }, [list, press, listed, back])
  // A Code session's way out stays the leading control it has always been: it leads back to Code,
  // which is a place a screen opened, not a list its row stands in.
  const leading = underCode ? (
    <BackButton label="Back to Code" onClick={() => void leave?.()} floating />
  ) : undefined
  // The bar's corner, at every width: the list beside a conversation is a lane of the same screen, so
  // the control stands there too rather than letting each width guess where its way back is.
  const words = label ?? (botRow ? `Back to ${labelOf(labels, botRow)}` : undefined)
  const wayBack =
    list && words ? <BackButton label={words} onClick={() => ontoList()} floating /> : undefined
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

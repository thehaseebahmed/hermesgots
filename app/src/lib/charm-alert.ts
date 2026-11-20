/**
 * The rules the charm's alerts obey, kept pure — the protocol's own bounds and no radio — so a
 * desktop test can run them.
 */
import { CHARM_MAX_ACTIONS, type CharmAlertAction } from "./charm-protocol.ts"

/**
 * The id a charm's bot entry carries: the registry's when the registry holds this bot, since that
 * is the id a push names and the id an alert is matched against, and the bot's own otherwise.
 */
export function charmBotId(profileId: string, registryId?: string): string {
  return registryId ? registryId : profileId
}

/**
 * Minutes since local midnight, which is how an alert says when it was raised: the reader's own
 * clock, so the charm's minute agrees with the one on the phone. The moment is handed in, never
 * read here, so a test builds the same frame every time.
 */
export function minuteOfDay(now: Date): number {
  return now.getHours() * 60 + now.getMinutes()
}

/**
 * The buttons an alert carries, from a notice's own: at most two, each with the label the tray
 * draws and an id a press answers by. A notice's button has no id of its own — the plugin sends a
 * label and a link (`actions_wire` in `plugin/notice.py`) — so the id is the button's place in that
 * list, which is the id the tray's own press carries too (`answerIntent`'s index on the phone).
 */
export function charmButtons(actions: readonly { label: string }[]): CharmAlertAction[] {
  return actions
    .slice(0, CHARM_MAX_ACTIONS)
    .map((action, at) => ({ id: String(at), label: action.label }))
}

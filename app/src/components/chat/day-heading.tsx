import { Divider } from "@/components/chat/divider"

/**
 * A day's first row in a bot's Main, under a break whose words are the day itself. The day divides a
 * flow of messages, thread cards and moved markers, which is what Main draws, so a project session
 * draws none: its turns are one conversation and stay undivided (ADR 0087). It is a separator like
 * the other breaks, so a reader who can't see it is still told the day turned.
 */
export function DayHeading({ day }: { day: string }) {
  return <Divider text={day} spoken={day} slot="day-heading" />
}

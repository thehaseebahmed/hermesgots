import { getReminderLevel, setReminderLevel, type ReminderLevel } from "@/lib/hermes"
import { useHostRecord, type HostRoute } from "@/lib/host-record"

/**
 * A bot's progress updates, held on its host (`progress.py`, ADR 0068): the level it answers, and
 * the one a pick writes. The feature is the host's own, so an older plugin offers no row at all.
 */
const REMINDERS: HostRoute<ReminderLevel> = {
  feature: "progress_reminders",
  label: "the progress updates setting",
  read: (server, signal) => getReminderLevel(server, signal),
  write: (server, level, signal) => setReminderLevel(server, level, signal),
}

export function useReminders(profile: { baseUrl: string; apiKey: string } | null | undefined) {
  return useHostRecord(profile, REMINDERS, "normal")
}

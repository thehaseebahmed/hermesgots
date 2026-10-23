/**
 * The interface switch: one boolean the host keeps for the profile, read when a screen opens and
 * written when the user changes it. Off means both halves stop — the host stops telling the model
 * the component library, and the app draws a reply's block as the code it came from (ADR 0033).
 *
 * It is a host setting, not a device one: it is deliberately not in `APPEARANCE_FIELDS`, because the
 * cost it saves is paid on the host. `useHostRecord` already gates it on the host's own `openui`
 * feature.
 */
import { getOpenUI, setOpenUI } from "@/lib/hermes"
import type { HostRoute } from "@/lib/host-record"

export const OPENUI_SWITCH: HostRoute<boolean> = {
  feature: "openui",
  label: "the interface switch",
  read: getOpenUI,
  write: setOpenUI,
}

/** A host that can't answer leaves the app drawing, as it did before this switch existed. */
export const UNANSWERED_IS_ON = true

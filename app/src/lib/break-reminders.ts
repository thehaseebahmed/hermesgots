export const INITIAL_DELAY_MS = 30_000
export const REPEAT_INTERVAL_MS = 60 * 60_000

interface ReminderDevice {
  /** Capacitor returns `android` in the native Android application and `web` in a PWA/browser. */
  platform: string
  standalone: boolean
  /** iOS Safari's standalone PWA signal. */
  appleStandalone: boolean
  userAgent: string
  viewportWidth: number
}

const PHONE_USER_AGENT = /(?:iPhone|iPod|Android.+Mobile)/i

/** Only Android native phones and installed standalone PWAs on phones receive these reminders. */
export function isEligibleReminderDevice(device: ReminderDevice) {
  if (device.viewportWidth >= 768 || !PHONE_USER_AGENT.test(device.userAgent)) return false
  if (device.platform === "android") return true
  return device.platform === "web" && (device.standalone || device.appleStandalone)
}

export interface BackgroundRunState {
  busy: boolean
  runId?: string
  awaitingApproval: boolean
  awaitingClarify: boolean
  theseusWaits: boolean
  resolved: boolean
  discarded: boolean
  blocked: boolean
}

export function isBackgroundSafeRunActive(state: BackgroundRunState) {
  return (
    state.busy &&
    Boolean(state.runId) &&
    !state.awaitingApproval &&
    !state.awaitingClarify &&
    !state.theseusWaits &&
    !state.resolved &&
    !state.discarded &&
    !state.blocked
  )
}

export interface ReminderClockSnapshot {
  hasShown: boolean
  open: boolean
  cooldown: number
}

/** Counts qualifying foreground time, pausing when the page or active work becomes ineligible. */
export class ReminderClock {
  private lastAt?: number
  private lastEligible = false
  private foregroundDwell = 0
  private cooldown: number
  private hasShown: boolean
  private open: boolean

  constructor(snapshot?: Partial<ReminderClockSnapshot>) {
    this.cooldown = snapshot?.cooldown ?? 0
    this.hasShown = snapshot?.hasShown ?? false
    this.open = snapshot?.open ?? false
  }

  snapshot(): ReminderClockSnapshot {
    return {
      hasShown: this.hasShown,
      open: this.open,
      cooldown: this.cooldown,
    }
  }

  reset() {
    this.lastAt = undefined
    this.lastEligible = false
    this.foregroundDwell = 0
    this.cooldown = 0
    this.hasShown = false
    this.open = false
  }

  update(now: number, eligible: boolean) {
    const continuing = eligible && this.lastEligible && this.lastAt !== undefined
    const elapsed = continuing ? Math.max(0, now - this.lastAt!) : 0

    if (continuing) {
      this.foregroundDwell += elapsed
      if (this.hasShown && !this.open) this.cooldown += elapsed
    } else {
      this.foregroundDwell = 0
    }

    this.lastAt = now
    this.lastEligible = eligible

    if (!eligible || this.open) return false
    if (!this.hasShown && this.foregroundDwell >= INITIAL_DELAY_MS) {
      this.hasShown = true
      this.open = true
      return true
    }
    if (
      this.hasShown &&
      this.cooldown >= REPEAT_INTERVAL_MS &&
      this.foregroundDwell >= INITIAL_DELAY_MS
    ) {
      this.open = true
      return true
    }
    return false
  }

  /** Start the next hourly cooldown when the user dismisses the current reminder. */
  dismiss(now: number, eligible = true) {
    this.open = false
    this.cooldown = 0
    this.foregroundDwell = 0
    this.lastAt = now
    this.lastEligible = eligible
  }
}

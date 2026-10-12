import assert from "node:assert/strict"
import test from "node:test"

import {
  INITIAL_DELAY_MS,
  REPEAT_INTERVAL_MS,
  ReminderClock,
  isBackgroundSafeRunActive,
  isEligibleReminderDevice,
} from "../src/lib/break-reminders.ts"

test("eligibility is limited to Android phones and standalone phone PWAs", () => {
  const androidPhone = {
    platform: "android",
    standalone: false,
    appleStandalone: false,
    userAgent: "Mozilla/5.0 (Linux; Android 16; Pixel 10) Mobile Safari/537.36",
    viewportWidth: 390,
  }
  assert.equal(isEligibleReminderDevice(androidPhone), true)
  assert.equal(isEligibleReminderDevice({ ...androidPhone, platform: "ios" }), false)
  assert.equal(
    isEligibleReminderDevice({
      ...androidPhone,
      userAgent: "Mozilla/5.0 (Linux; Android 16; Tablet)",
    }),
    false,
  )
  assert.equal(isEligibleReminderDevice({ ...androidPhone, viewportWidth: 768 }), false)
  assert.equal(
    isEligibleReminderDevice({ ...androidPhone, platform: "web", standalone: false }),
    false,
  )
  assert.equal(
    isEligibleReminderDevice({ ...androidPhone, platform: "web", standalone: true }),
    true,
  )
  assert.equal(
    isEligibleReminderDevice({
      ...androidPhone,
      platform: "web",
      standalone: false,
      appleStandalone: true,
      userAgent: "Mozilla/5.0 (iPhone; CPU iPhone OS 19_0 like Mac OS X)",
    }),
    true,
  )
})

test("the first reminder waits for 30 seconds of continuous eligible foreground use", () => {
  const clock = new ReminderClock()
  assert.equal(clock.update(0, true), false)
  assert.equal(clock.update(INITIAL_DELAY_MS - 1, true), false)
  assert.equal(clock.update(INITIAL_DELAY_MS, true), true)
  assert.equal(clock.update(INITIAL_DELAY_MS + 1, true), false)
})

test("ineligible time resets the dwell and does not count toward the first reminder", () => {
  const clock = new ReminderClock()
  assert.equal(clock.update(0, true), false)
  assert.equal(clock.update(10_000, true), false)
  assert.equal(clock.update(600_000, false), false)
  assert.equal(clock.update(600_000, true), false)
  assert.equal(clock.update(600_000 + INITIAL_DELAY_MS - 1, true), false)
  assert.equal(clock.update(600_000 + INITIAL_DELAY_MS, true), true)
})

test("the repeat interval counts eligible foreground time after dismissal", () => {
  const clock = new ReminderClock()
  assert.equal(clock.update(0, true), false)
  assert.equal(clock.update(INITIAL_DELAY_MS, true), true)
  clock.dismiss(INITIAL_DELAY_MS)

  const beforeRepeat = INITIAL_DELAY_MS + REPEAT_INTERVAL_MS - 1
  assert.equal(clock.update(beforeRepeat, true), false)
  assert.equal(clock.update(beforeRepeat + 1, true), true)
})

test("time away pauses the repeat interval and the next reminder needs 30 seconds back", () => {
  const clock = new ReminderClock()
  assert.equal(clock.update(0, true), false)
  assert.equal(clock.update(INITIAL_DELAY_MS, true), true)
  clock.dismiss(INITIAL_DELAY_MS)

  const thirtyMinutes = INITIAL_DELAY_MS + 30 * 60_000
  assert.equal(clock.update(thirtyMinutes, true), false)
  assert.equal(clock.update(thirtyMinutes + 60 * 60_000, false), false)
  const resumed = thirtyMinutes + 2 * 60 * 60_000
  assert.equal(clock.update(resumed, true), false)
  assert.equal(clock.update(resumed + INITIAL_DELAY_MS - 1, true), false)
  assert.equal(clock.update(resumed + INITIAL_DELAY_MS, true), false)

  const remainingCooldown = 30 * 60_000 - INITIAL_DELAY_MS
  assert.equal(clock.update(resumed + INITIAL_DELAY_MS + remainingCooldown - 1, true), false)
  assert.equal(clock.update(resumed + INITIAL_DELAY_MS + remainingCooldown, true), true)
})

test("a restored pending reminder remains open and starts a full repeat cooldown when dismissed", () => {
  const clock = new ReminderClock({ hasShown: true, open: true, cooldown: 20_000 })
  assert.equal(clock.snapshot().open, true)
  assert.equal(clock.update(0, true), false)
  clock.dismiss(0, true)

  assert.equal(clock.update(INITIAL_DELAY_MS, true), false)
  assert.equal(clock.update(REPEAT_INTERVAL_MS - 1, true), false)
  assert.equal(clock.update(REPEAT_INTERVAL_MS, true), true)
})

test("only a live backend run that does not need the user can trigger reminders", () => {
  const active = {
    busy: true,
    runId: "run-1",
    awaitingApproval: false,
    awaitingClarify: false,
    theseusWaits: false,
    resolved: false,
    discarded: false,
    blocked: false,
  }
  assert.equal(isBackgroundSafeRunActive(active), true)
  assert.equal(isBackgroundSafeRunActive({ ...active, runId: undefined }), false)
  assert.equal(isBackgroundSafeRunActive({ ...active, busy: false }), false)
  assert.equal(isBackgroundSafeRunActive({ ...active, awaitingApproval: true }), false)
  assert.equal(isBackgroundSafeRunActive({ ...active, awaitingClarify: true }), false)
  assert.equal(isBackgroundSafeRunActive({ ...active, theseusWaits: true }), false)
  assert.equal(isBackgroundSafeRunActive({ ...active, resolved: true }), false)
  assert.equal(isBackgroundSafeRunActive({ ...active, discarded: true }), false)
  assert.equal(isBackgroundSafeRunActive({ ...active, blocked: true }), false)
})

test("reset clears the reminder and timing state when reminders are disabled", () => {
  const clock = new ReminderClock({ hasShown: true, open: true, cooldown: 20_000 })
  clock.reset()
  assert.deepEqual(clock.snapshot(), { hasShown: false, open: false, cooldown: 0 })
  assert.equal(clock.update(0, true), false)
  assert.equal(clock.update(INITIAL_DELAY_MS, true), true)
})

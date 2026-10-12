import { useCallback, useEffect, useRef, useState } from "react"
import { useLiveQuery } from "dexie-react-hooks"
import { App } from "@capacitor/app"
import { Capacitor } from "@capacitor/core"

import { BreakReminderActivityContext } from "@/components/break-reminder-context"
import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog"
import { Button } from "@/components/ui/button"
import { DEFAULT_SETTINGS, getSettings } from "@/lib/db"
import { ReminderClock, isEligibleReminderDevice } from "@/lib/break-reminders"
import { isNative, minimizeAndroidApp } from "@/lib/native"

const STORAGE_KEY = "memento:break-reminders"

const MESSAGES = [
  "Your agent's got this. Go live a little.",
  "The backend's on it. Your thumbs can clock out.",
  "Your code can cook without an audience.",
  "Go stretch. The task's still ticking.",
  "Hermes is on the job; you're off the clock.",
  "Take a lap. The task won't run away.",
  "Go hydrate. Your agent's got the keyboard.",
  "The server's got this shift. Go enjoy yours.",
  "Give those thumbs a break; your task keeps ticking.",
  "Go find a snack. Your agent can keep at it.",
  "You can be elsewhere; the backend's still working.",
  "Time for a side quest. Hermes will keep going.",
]

interface SavedReminder {
  clock: { hasShown: boolean; open: boolean; cooldown: number }
  pending?: string
  lastMessage?: string
}

function readSavedReminder(): SavedReminder | undefined {
  try {
    const value: unknown = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "null")
    if (!value || typeof value !== "object") return undefined
    const saved = value as Partial<SavedReminder>
    const clock = saved.clock
    if (
      !clock ||
      typeof clock.hasShown !== "boolean" ||
      typeof clock.open !== "boolean" ||
      typeof clock.cooldown !== "number" ||
      !Number.isFinite(clock.cooldown) ||
      clock.cooldown < 0
    )
      return undefined
    const pending =
      typeof saved.pending === "string" && MESSAGES.includes(saved.pending)
        ? saved.pending
        : undefined
    const lastMessage =
      typeof saved.lastMessage === "string" && MESSAGES.includes(saved.lastMessage)
        ? saved.lastMessage
        : undefined
    return {
      clock: { ...clock, hasShown: clock.hasShown || Boolean(pending), open: Boolean(pending) },
      pending,
      lastMessage,
    }
  } catch {
    return undefined
  }
}

function writeSavedReminder(saved: SavedReminder) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(saved))
  } catch {
    // A blocked local store only prevents restoring the reminder after the page is unloaded.
  }
}

function clearSavedReminder() {
  try {
    localStorage.removeItem(STORAGE_KEY)
  } catch {
    // The preference still works for this page even when storage is unavailable.
  }
}

function nextMessage(previous?: string) {
  const choices = MESSAGES.filter((message) => message !== previous)
  return choices[Math.floor(Math.random() * choices.length)]
}

function phoneAppEligible() {
  return isEligibleReminderDevice({
    platform: Capacitor.getPlatform(),
    standalone: window.matchMedia("(display-mode: standalone)").matches,
    appleStandalone: (navigator as Navigator & { standalone?: boolean }).standalone === true,
    userAgent: navigator.userAgent,
    viewportWidth: window.innerWidth,
  })
}

export function BreakReminderProvider({ children }: { children: React.ReactNode }) {
  const [saved] = useState(readSavedReminder)
  const [reminder, setReminder] = useState<string | null>(() =>
    phoneAppEligible() ? (saved?.pending ?? null) : null,
  )
  const settings = useLiveQuery(getSettings, [])
  const enabled = settings?.breakReminders ?? DEFAULT_SETTINGS.breakReminders
  const [clock] = useState(
    () =>
      new ReminderClock(
        saved?.pending ? { ...saved.clock, hasShown: true, open: true } : saved?.clock,
      ),
  )
  const lastMessage = useRef(saved?.lastMessage ?? saved?.pending)
  const reminderRef = useRef(reminder)
  const activeRef = useRef(false)
  const visibleRef = useRef(document.visibilityState === "visible")
  const eligibleRef = useRef(false)
  const android = isNative && Capacitor.getPlatform() === "android"

  const reportActivity = useCallback((active: boolean) => {
    activeRef.current = active
  }, [])

  const dismiss = useCallback(() => {
    const current = clock
    current.dismiss(Date.now(), eligibleRef.current)
    reminderRef.current = null
    setReminder(null)
    writeSavedReminder({ clock: current.snapshot(), lastMessage: lastMessage.current })
  }, [clock])

  useEffect(() => {
    let current = true
    let nativeHandle: { remove: () => Promise<void> } | undefined

    if (!enabled) {
      eligibleRef.current = false
      reminderRef.current = null
      lastMessage.current = undefined
      clock.reset()
      clearSavedReminder()
      return
    }

    const tick = () => {
      if (!current) return
      const phone = phoneAppEligible()
      const eligible = visibleRef.current && activeRef.current && phone
      eligibleRef.current = eligible

      const timer = clock
      const triggered = timer.update(Date.now(), eligible)
      if (triggered) {
        const message = nextMessage(lastMessage.current)
        lastMessage.current = message
        reminderRef.current = message
        setReminder(message)
      }
      if (timer.snapshot().hasShown && phone) {
        writeSavedReminder({
          clock: timer.snapshot(),
          pending: reminderRef.current ?? undefined,
          lastMessage: lastMessage.current,
        })
      }
    }

    const onVisibility = () => {
      visibleRef.current = document.visibilityState === "visible"
      tick()
    }
    const onResize = () => tick()
    document.addEventListener("visibilitychange", onVisibility)
    window.addEventListener("resize", onResize)
    tick()
    const interval = window.setInterval(tick, 1000)

    if (android) {
      void App.addListener("appStateChange", ({ isActive }) => {
        visibleRef.current = isActive && document.visibilityState === "visible"
        tick()
      }).then((listener) => {
        if (current) nativeHandle = listener
        else void listener.remove()
      })
    }

    return () => {
      current = false
      document.removeEventListener("visibilitychange", onVisibility)
      window.removeEventListener("resize", onResize)
      window.clearInterval(interval)
      if (nativeHandle) void nativeHandle.remove()
      clock.update(Date.now(), false)
    }
  }, [android, clock, enabled])

  useEffect(() => {
    reminderRef.current = reminder
  }, [reminder])

  return (
    <BreakReminderActivityContext.Provider value={reportActivity}>
      {children}
      <AlertDialog
        open={Boolean(settings && enabled && reminder && clock.snapshot().open)}
        onOpenChange={(open) => !open && dismiss()}
      >
        <AlertDialogContent size="sm">
          <AlertDialogHeader>
            <AlertDialogTitle>{reminder}</AlertDialogTitle>
            <AlertDialogDescription>
              <div className="space-y-2">
                <p>Your task keeps running in the background. Come back if it needs you.</p>
                {!android && (
                  <p>
                    Background this app now. Your task will keep running; come back later to dismiss
                    this reminder.
                  </p>
                )}
              </div>
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            {android && (
              <Button variant="outline" onClick={() => void minimizeAndroidApp()}>
                Put this away
              </Button>
            )}
            <AlertDialogCancel>Dismiss</AlertDialogCancel>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </BreakReminderActivityContext.Provider>
  )
}

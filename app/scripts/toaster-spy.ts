/**
 * The page's toaster, taken in place of the real one, so a test reads what the app said without
 * drawing it. All four tones are taken, because `lib/tell` can reach any of them.
 */
import { toast } from "sonner"

export interface Said {
  tone: "error" | "info" | "success" | "note"
  text: string
  data?: { duration?: number }
}

/**
 * `sink` is given every sentence as it is said, in the order it is said — so a case that has to see
 * the words arrive (a screen whose answer is awaited) polls an array that is already growing, rather
 * than one filled when the toaster is put back.
 */
export function spyToaster(sink: string[] = []) {
  const heard: Said[] = []
  let dismissed = 0
  const real = {
    error: toast.error,
    info: toast.info,
    success: toast.success,
    message: toast.message,
    dismiss: toast.dismiss,
  }
  const take =
    (tone: Said["tone"]) =>
    (text: string, data?: { duration?: number }) => {
      heard.push({ tone, text, data })
      sink.push(String(text))
    }
  toast.error = take("error") as typeof toast.error
  toast.info = take("info") as typeof toast.info
  toast.success = take("success") as typeof toast.success
  toast.message = take("note") as typeof toast.message
  toast.dismiss = (() => {
    dismissed += 1
  }) as typeof toast.dismiss
  return {
    heard,
    get dismissed() {
      return dismissed
    },
    restore: () => Object.assign(toast, real),
  }
}

/**
 * Runs `run` while the toaster is taken, and answers what it was told once the promises the run
 * started have landed.
 */
export async function saidDuring(run: () => void) {
  const toaster = spyToaster()
  try {
    run()
  } finally {
    await new Promise((resolve) => setTimeout(resolve, 0))
    toaster.restore()
  }
  return toaster.heard
}

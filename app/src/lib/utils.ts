import { clsx, type ClassValue } from "clsx"
import { type MouseEvent } from "react"
import { twMerge } from "tailwind-merge"

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
}

/**
 * A link to the screen you are already on stays a link — the sentence reads the same, and
 * `aria-current` says it is here — but it goes nowhere: reopening it would only remount the pane
 * the thread is already in.
 */
export const stayHere = (here: boolean) =>
  here ? (event: MouseEvent) => event.preventDefault() : undefined

/** `crypto.randomUUID` only exists in secure contexts (HTTPS or localhost); LAN HTTP lacks it. */
export function randomId(): string {
  if (typeof crypto.randomUUID === "function") return crypto.randomUUID()
  const bytes = crypto.getRandomValues(new Uint8Array(16))
  bytes[6] = (bytes[6] & 0x0f) | 0x40
  bytes[8] = (bytes[8] & 0x3f) | 0x80
  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("")
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
}

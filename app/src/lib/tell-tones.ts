/**
 * The tones the app says things in passing, as values rather than a type alone.
 *
 * `lib/tell.ts` derives `TellTone` from this list, and the guard over toasts
 * (`scripts/test-error-toasts.mjs`) reads the list itself — so a fifth tone is a tone the guard
 * reads without being told, and one it cannot forget. Import-free, so both the seam and the guard
 * read it: the seam reaches sonner and the phone's bridge, and the unit tier reaches neither.
 */
export const TELL_TONES = ["error", "info", "success", "note"] as const

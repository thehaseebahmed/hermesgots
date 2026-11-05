import { useEffect } from "react"

/**
 * The edit on screen, where it holds changes no Save has taken. A form registers while its field
 * differs from the value it opened with, and the screen that would leave asks before it goes: going
 * back without Save is Cancel, and Cancel is only a promise once the typing is gone with it.
 *
 * It is a module's own flag rather than a context because the back that leaves is drawn by the route
 * above the form, and one screen holds one edit at a time.
 */
let held = false

/** Keeps `held` true while this edit differs from what it opened with. */
export function useUnsavedChanges(dirty: boolean) {
  useEffect(() => {
    held = dirty
  }, [dirty])
  useEffect(
    () => () => {
      held = false
    },
    [],
  )
}

/** Whether the edit on screen holds changes a back would throw away. */
export function holdsUnsavedChanges() {
  return held
}

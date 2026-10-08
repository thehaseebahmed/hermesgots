/**
 * Every toast sits at the bottom, a standard margin above the screen's edge. A screen marks what a
 * toast mustn't cover with `data-toast-above` (a chat's composer, the Code screen's New project
 * button) and the toast rises to clear the highest of them. `--toast-bottom` is what the toaster's
 * offset reads.
 */
const GAP = 8
const STANDARD = "max(1rem, env(safe-area-inset-bottom))"

export function placeToasts() {
  let bottom = 0
  for (const el of document.querySelectorAll("[data-toast-above]")) {
    const { top, height } = el.getBoundingClientRect()
    if (height) bottom = Math.max(bottom, window.innerHeight - top)
  }
  document.documentElement.style.setProperty(
    "--toast-bottom",
    bottom ? `${bottom + GAP}px` : STANDARD,
  )
}

/** Keeps `--toast-bottom` current as screens, and what they keep at the bottom, come and go. */
export function watchToastOffset() {
  let frame = 0
  const schedule = () => {
    if (frame) return
    frame = requestAnimationFrame(() => {
      frame = 0
      placeToasts()
    })
  }
  new MutationObserver(schedule).observe(document.body, { childList: true, subtree: true })
  window.addEventListener("resize", schedule)
  schedule()
}

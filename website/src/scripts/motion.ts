/**
 * The site's script: one-shot reveals, the headline that becomes the name at the first scroll, the
 * nav's glass once the page scrolls and the waiting list's form. Everything is progressive: without
 * the script (or with reduced motion) the page is a plain stack, so nothing is hidden until this says
 * it can animate.
 */

const root = document.documentElement
const reduced = matchMedia("(prefers-reduced-motion: reduce)").matches

root.classList.add("js")

if (!reduced && "IntersectionObserver" in window) {
  root.classList.add("motion")
  const seen = new IntersectionObserver(
    (entries) => {
      for (const entry of entries) {
        if (!entry.isIntersecting) continue
        entry.target.classList.add("is-in")
        seen.unobserve(entry.target)
      }
    },
    { rootMargin: "0px 0px -10% 0px", threshold: 0.1 },
  )
  document.querySelectorAll("[data-reveal]:not(.ss-stage *)").forEach((element) => seen.observe(element))
}

// The nav takes its glass once the page has moved under it.
const nav = document.querySelector<HTMLElement>("[data-nav]")
if (nav) {
  const update = () => nav.classList.toggle("is-scrolled", window.scrollY > 8)
  update()
  window.addEventListener("scroll", update, { passive: true })
}

// The headline becomes the name the first time the reader goes to scroll: a wheel or a swipe counts
// as much as the page moving, so it answers the gesture rather than the first pixel. A page opened
// already scrolled (a reload, a link to a section) shows the name at once.
const title = document.querySelector<HTMLElement>("[data-hero-title]")
if (title) {
  const gestures = ["scroll", "wheel", "touchmove"] as const
  const onKey = (event: KeyboardEvent) => {
    if (["ArrowDown", "PageDown", " ", "End"].includes(event.key)) meet()
  }
  const meet = () => {
    title.classList.add("is-met")
    for (const type of gestures) removeEventListener(type, meet)
    removeEventListener("keydown", onKey)
  }
  if (window.scrollY > 4) {
    title.querySelectorAll<HTMLElement>(".ht-w").forEach((word) => (word.style.transition = "none"))
    meet()
  } else {
    for (const type of gestures) addEventListener(type, meet, { passive: true })
    addEventListener("keydown", onKey)
  }
}

document.querySelectorAll<HTMLFormElement>("[data-waitlist]").forEach((form) => {
  form.addEventListener("submit", async (event) => {
    event.preventDefault()
    form.classList.remove("is-failed")
    const button = form.querySelector("button")
    if (button) button.disabled = true
    try {
      const body = new URLSearchParams(new FormData(form) as unknown as Record<string, string>)
      const res = await fetch(form.action, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: body.toString(),
      })
      if (!res.ok) throw new Error(String(res.status))
      form.classList.add("is-done")
    } catch {
      form.classList.add("is-failed")
    } finally {
      if (button) button.disabled = false
    }
  })
})

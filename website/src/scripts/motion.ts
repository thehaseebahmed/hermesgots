/**
 * The site's script: one-shot reveals, the headline that becomes the name at the first reach for the hero, the
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

// The headline becomes the name the first time the reader reaches for the hero: a mouse over it, a
// tap anywhere in it, or the keyboard moving into it. A scroll would come too late on a phone,
// where the hero is most of the first screen.
const hero = document.querySelector<HTMLElement>("[data-hero]")
const title = hero?.querySelector<HTMLElement>("[data-hero-title]")
if (hero && title) {
  // A mouse only counts once the reader moves it: the browser sends moves of its own, with no
  // movement in them, under a cursor that was resting there as the page drew
  const mouse = matchMedia("(hover: hover) and (pointer: fine)").matches
  const onMove = (event: PointerEvent) => {
    if (mouse && event.pointerType === "mouse" && (event.movementX || event.movementY)) meet()
  }
  const meet = () => {
    title.classList.add("is-met")
    hero.removeEventListener("pointermove", onMove)
    hero.removeEventListener("pointerdown", meet)
    hero.removeEventListener("focusin", meet)
  }
  hero.addEventListener("pointermove", onMove)
  hero.addEventListener("pointerdown", meet)
  hero.addEventListener("focusin", meet)
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

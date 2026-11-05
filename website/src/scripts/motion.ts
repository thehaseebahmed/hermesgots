/**
 * Scroll motion for the landing page: one-shot reveals, and the bottom dock that steps aside while
 * the hero buttons, the waiting list or the footer are on screen. Everything is progressive: without the script (or
 * with reduced motion) the page is a plain stack, so nothing is hidden until this says it can animate.
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
  document.querySelectorAll("[data-reveal]").forEach((element) => seen.observe(element))
}

const dock = document.querySelector<HTMLElement>("[data-dock]")
if (dock && "IntersectionObserver" in window) {
  const covering = new Set<Element>()
  const watch = new IntersectionObserver((entries) => {
    for (const entry of entries) {
      if (entry.isIntersecting) covering.add(entry.target)
      else covering.delete(entry.target)
    }
    dock.classList.toggle("is-away", covering.size > 0)
  })
  document.querySelectorAll("#pricing, .footer, .home-hero .cta").forEach((element) => watch.observe(element))
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

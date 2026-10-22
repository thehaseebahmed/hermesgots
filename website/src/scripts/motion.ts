/**
 * Scroll motion for the landing page: reveals, the hero's parallax and the sticky story that swaps
 * its slide as you scroll. Everything is progressive: without it (or with reduced motion) the page is
 * a plain stack, so nothing is hidden until this script says it can animate.
 */

const root = document.documentElement
const reduced = matchMedia("(prefers-reduced-motion: reduce)").matches
const clamp = (value: number, min = 0, max = 1) => Math.min(max, Math.max(min, value))

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
    { rootMargin: "0px 0px -12% 0px", threshold: 0.12 },
  )
  document.querySelectorAll("[data-reveal]").forEach((element) => seen.observe(element))
}

const hero = document.querySelector<HTMLElement>("[data-hero]")
const stories = [...document.querySelectorAll<HTMLElement>("[data-story]")]

function story(element: HTMLElement) {
  const count = Number(element.dataset.count)
  const total = element.offsetHeight - innerHeight
  const progress = total > 0 ? clamp(-element.getBoundingClientRect().top / total, 0, 0.9999) : 0
  const active = String(Math.floor(progress * count))
  element.style.setProperty("--p", progress.toFixed(3))
  if (element.dataset.active === active) return
  element.dataset.active = active
  element.querySelectorAll<HTMLElement>("[data-i]").forEach((item) => {
    item.setAttribute("aria-hidden", String(item.dataset.i !== active))
  })
  element.querySelectorAll<HTMLElement>("[data-dot]").forEach((dot) => {
    dot.setAttribute("aria-current", String(dot.dataset.dot === active))
  })
}

let queued = false
function update() {
  queued = false
  if (hero && root.classList.contains("motion")) {
    const progress = clamp(scrollY / (hero.offsetHeight * 0.8))
    hero.style.setProperty("--hero", progress.toFixed(3))
  }
  stories.forEach(story)
}

function schedule() {
  if (queued) return
  queued = true
  requestAnimationFrame(update)
}

addEventListener("scroll", schedule, { passive: true })
addEventListener("resize", schedule)
update()

for (const element of stories) {
  element.querySelectorAll<HTMLButtonElement>("[data-dot]").forEach((dot) => {
    dot.addEventListener("click", () => {
      const count = Number(element.dataset.count)
      const total = element.offsetHeight - innerHeight
      const top = element.getBoundingClientRect().top + scrollY
      const target = top + ((Number(dot.dataset.dot) + 0.5) / count) * total
      scrollTo({ top: target, behavior: reduced ? "auto" : "smooth" })
    })
  })
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

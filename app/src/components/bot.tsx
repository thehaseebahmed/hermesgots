import { useEffect, useRef, useState } from "react"

import {
  BOT_MOODS,
  BOTS,
  DEFAULT_BOT_ID,
  DEFAULT_MOOD,
  botImage,
  type BotDefinition,
  type BotMood,
} from "@/components/bots"
import { prefersReducedMotion } from "@/lib/media"
import { cn } from "@/lib/utils"

/**
 * Renders a bot still by default; `animate` (used by the header and the empty-state hero) brings it
 * to life. A posed bot (`posed` in bots.tsx) drawn with `animate` shows the pose `mood` names, moves
 * in that mood's own way and changes between moods in a poof; drawn still it is always its happy
 * pose, and a bot with one picture ignores `mood`.
 */
export function Bot({
  id = DEFAULT_BOT_ID,
  animate = false,
  mood = DEFAULT_MOOD,
  className,
}: {
  id?: string
  animate?: boolean
  mood?: BotMood
  className?: string
}) {
  const bot = BOTS.find((b) => b.id === id) ?? BOTS[0]

  if (bot.posed && animate) return <PosedBot bot={bot} mood={mood} className={className} />

  return (
    <span
      role="img"
      aria-label={bot.name}
      className={cn("inline-block size-8 shrink-0", animate && "bot-animate", className)}
    >
      <img
        src={botImage(bot)}
        alt=""
        draggable={false}
        className={cn("size-full object-contain select-none", `bot-anim-${bot.id}`)}
      />
    </span>
  )
}

/** The smoke's puffs: the like button's burst throws eight. */
const PUFFS = 8

const frame = () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve()))
const wait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

/** A duration the stylesheet holds, read where it is set so the two never drift (`250ms` → 250). */
function cssMs(el: Element, name: string, fallback: number) {
  const value = getComputedStyle(el).getPropertyValue(name).trim()
  const ms = value.endsWith("ms")
    ? parseFloat(value)
    : value.endsWith("s")
      ? parseFloat(value) * 1000
      : NaN
  return Number.isFinite(ms) ? ms : fallback
}

/** Replays a CSS animation keyed to a class or an attribute: off, a reflow, on. */
function replay(el: HTMLElement, set: (on: boolean) => void) {
  set(false)
  void el.offsetWidth
  set(true)
}

/**
 * The poof (transitions.dev's like-button burst): each puff is sent on its own vector, sized and thrown
 * by the box's own width so a small bot throws a small puff, and they rise as smoke does.
 */
function aim(puffs: HTMLElement, width: number) {
  const dots = [...puffs.children] as HTMLElement[]
  dots.forEach((dot, i) => {
    const angle = (i / dots.length) * Math.PI * 2 + Math.random() * 0.6
    const far = width * (0.42 + Math.random() * 0.3)
    dot.style.setProperty("--px", `${Math.cos(angle) * far}px`)
    dot.style.setProperty("--py", `${Math.sin(angle) * far * 0.8 - width * 0.12}px`)
    dot.style.setProperty("--psize", `${(0.85 + Math.random() * 0.6).toFixed(2)}`)
    dot.style.setProperty("--pdur", `${Math.round(520 + Math.random() * 180)}ms`)
    dot.style.setProperty("--pdelay", `${Math.round(Math.random() * 60)}ms`)
    dot.style.setProperty("--p-end-scale", `${(1.2 + Math.random() * 0.5).toFixed(2)}`)
  })
}

type Slot = "a" | "b"
const other = (slot: Slot): Slot => (slot === "a" ? "b" : "a")

/**
 * A posed bot's two poses sit in one cell (transitions.dev's icon swap), so a change of mood is the old
 * pose shrinking and blurring out while the new one grows in over it, the body giving a jelly squash
 * (the like button's pop) and throwing a puff of smoke (its burst). Each pose keeps its own mood's idle
 * motion, so the one leaving goes on moving as it fades rather than snapping still.
 */
function PosedBot({
  bot,
  mood,
  className,
}: {
  bot: BotDefinition
  mood: BotMood
  className?: string
}) {
  const [poses, setPoses] = useState<Record<Slot, BotMood>>({ a: mood, b: mood })
  const [front, setFront] = useState<Slot>("a")
  const frontNow = useRef<Slot>("a")
  const shownNow = useRef(mood)
  const wanted = useRef(mood)
  const flying = useRef(false)
  const alive = useRef(true)
  const box = useRef<HTMLSpanElement>(null)
  const puffs = useRef<HTMLSpanElement>(null)
  const images = { a: useRef<HTMLImageElement>(null), b: useRef<HTMLImageElement>(null) }

  // Every pose is in the cache before the first change, so a swap never waits on the network.
  useEffect(() => {
    for (const { id } of BOT_MOODS) document.createElement("img").src = botImage(bot, id)
  }, [bot])

  useEffect(() => {
    alive.current = true
    return () => {
      alive.current = false
    }
  }, [])

  useEffect(() => {
    wanted.current = mood
    if (flying.current) return
    flying.current = true
    void (async () => {
      try {
        // A mood asked for while one is changing waits for that swap, and only the newest is shown.
        while (alive.current && shownNow.current !== wanted.current) {
          const next = wanted.current
          const back = other(frontNow.current)
          setPoses((held) => ({ ...held, [back]: next }))
          await frame()
          // The pose coming in is decoded before it is shown, so it never paints half-loaded.
          await images[back].current?.decode?.().catch(() => {})
          if (!alive.current) return
          frontNow.current = back
          shownNow.current = next
          setFront(back)
          const el = box.current
          if (!el || prefersReducedMotion()) continue
          if (puffs.current) aim(puffs.current, el.offsetWidth)
          el.style.setProperty("--like-particle-size", `${Math.max(3, el.offsetWidth * 0.14)}px`)
          replay(el, (on) => (el.dataset.liked = String(on)))
          replay(el, (on) => el.classList.toggle("is-bursting", on))
          const smokeMs = cssMs(el, "--like-particle-dur", 600) + 300
          window.setTimeout(() => el.classList.remove("is-bursting"), smokeMs)
          await wait(cssMs(el, "--icon-swap-dur", 250))
        }
      } finally {
        flying.current = false
      }
    })()
    // `images` is two refs made on every render; the effect reads them through `.current` only.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mood])

  return (
    <span
      ref={box}
      role="img"
      aria-label={bot.name}
      data-liked="false"
      className={cn("t-like bot-animate relative inline-block size-8 shrink-0", className)}
    >
      <span ref={puffs} aria-hidden className="t-like-particles">
        {Array.from({ length: PUFFS }, (_, i) => (
          <i key={i} />
        ))}
      </span>
      <span className="t-like-icon block size-full">
        <span className="t-icon-swap size-full" data-state={front}>
          {(["a", "b"] as const).map((slot) => (
            <span
              key={slot}
              className="t-icon size-full"
              data-icon={slot}
              aria-hidden={slot !== front}
            >
              <img
                ref={images[slot]}
                src={botImage(bot, poses[slot])}
                alt=""
                draggable={false}
                data-mood={poses[slot]}
                className="bot-posed size-full object-contain select-none"
              />
            </span>
          ))}
        </span>
      </span>
    </span>
  )
}

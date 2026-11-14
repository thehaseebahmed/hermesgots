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

const OUT_MS = 240
const HIDDEN_MS = 120
const IN_MS = 380
const PUFFS = 9

const frame = () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve()))
const wait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

/** One animation's end; a cancelled one resolves rather than rejects, so a flight never throws. */
const done = (animation: Animation) =>
  animation.finished.then(
    () => {},
    () => {},
  )

/** Smoke thrown out from the middle of the box, sized and thrown by the box's own width. */
function puff(into: HTMLElement, width: number) {
  for (let i = 0; i < PUFFS; i++) {
    const angle = (i / PUFFS) * Math.PI * 2 + Math.random() * 0.5
    const far = width * (0.45 + Math.random() * 0.4)
    const size = width * (0.28 + Math.random() * 0.22)
    const x = Math.cos(angle) * far
    const y = Math.sin(angle) * far * 0.8
    const smoke = document.createElement("span")
    smoke.style.cssText = `position:absolute;left:50%;top:55%;width:${size}px;height:${size}px;border-radius:50%;background:var(--muted-foreground)`
    into.append(smoke)
    smoke
      .animate(
        [
          { transform: "translate(-50%,-50%) scale(.3)", opacity: 0.5 },
          {
            transform: `translate(calc(-50% + ${x * 0.6}px),calc(-50% + ${y * 0.6}px)) scale(1.1)`,
            opacity: 0.4,
            offset: 0.4,
          },
          {
            transform: `translate(calc(-50% + ${x}px),calc(-50% + ${y - width * 0.2}px)) scale(.6)`,
            opacity: 0,
          },
        ],
        { duration: 650, easing: "cubic-bezier(.2,.7,.3,1)" },
      )
      .finished.then(
        () => smoke.remove(),
        () => smoke.remove(),
      )
  }
}

function PosedBot({
  bot,
  mood,
  className,
}: {
  bot: BotDefinition
  mood: BotMood
  className?: string
}) {
  const [shown, setShown] = useState(mood)
  const shownNow = useRef(mood)
  const wanted = useRef(mood)
  const flying = useRef(false)
  const alive = useRef(true)
  const box = useRef<HTMLSpanElement>(null)
  const smoke = useRef<HTMLSpanElement>(null)
  const pose = useRef<HTMLSpanElement>(null)

  const show = (next: BotMood) => {
    shownNow.current = next
    setShown(next)
  }

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
        // A mood asked for while one is changing waits for it, and only the newest is shown.
        while (alive.current && shownNow.current !== wanted.current) {
          const next = wanted.current
          const el = pose.current
          const into = smoke.current
          if (!el || !into || !box.current || prefersReducedMotion() || !el.animate) {
            show(next)
            continue
          }
          puff(into, box.current.offsetWidth)
          await done(
            el.animate(
              [
                { transform: "scale(1)", opacity: 1 },
                { transform: "scale(1.12)", offset: 0.4 },
                { transform: "scale(0)", opacity: 0 },
              ],
              { duration: OUT_MS, easing: "ease-in", fill: "forwards" },
            ),
          )
          await wait(HIDDEN_MS)
          if (!alive.current) return
          show(next)
          await frame()
          await frame()
          await done(
            el.animate(
              [
                { transform: "scale(.2)", opacity: 0 },
                { transform: "scale(1.1)", opacity: 1, offset: 0.6 },
                { transform: "scale(1)", opacity: 1 },
              ],
              { duration: IN_MS, easing: "cubic-bezier(.3,1.4,.5,1)", fill: "forwards" },
            ),
          )
          el.getAnimations?.().forEach((animation) => animation.cancel())
        }
      } finally {
        flying.current = false
      }
    })()
  }, [mood])

  return (
    <span
      ref={box}
      role="img"
      aria-label={bot.name}
      className={cn("bot-animate relative inline-block size-8 shrink-0", className)}
    >
      <span ref={smoke} aria-hidden className="pointer-events-none absolute inset-0" />
      <span ref={pose} className="block size-full">
        <img
          src={botImage(bot, shown)}
          alt=""
          draggable={false}
          data-mood={shown}
          className="bot-posed size-full object-contain select-none"
        />
      </span>
    </span>
  )
}

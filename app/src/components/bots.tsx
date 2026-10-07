import type { ReactNode } from "react"

/**
 * Memento's bot characters (rendered by <Bot> in bot.tsx): calm, glassy little organisms built on
 * basic shapes, each with one accessory. Bodies have no straight edges: every outline is a smooth
 * curve with a slight wobble, like a cell under a microscope.
 * Each is still by default; pass `animate` (the header does) to bring it to life.
 * Animations live in index.css under `.bot-animate` and respect prefers-reduced-motion.
 */

interface Palette {
  /** Lit top of the glass. */
  top: string
  base: string
  /** Shaded underside and rim. */
  deep: string
}

interface BotDefinition {
  id: string
  name: string
  description: string
  /** `uid` keeps gradient and clip ids unique when several bots share a page. */
  draw: (uid: string) => ReactNode
}

type Point = [number, number]

/** Eye colour: a deep blue-black that sits softer on pastels than pure black. */
const INK = "#1f2233"
const GRAPHITE: Palette = { top: "#6b7180", base: "#454a57", deep: "#2a2e38" }
const FROST: Palette = { top: "#ffffff", base: "#eef0f6", deep: "#a9b0c2" }

/** A closed Catmull-Rom spline through `points`, as cubic Béziers, so the outline has no corners. */
function smoothPath(points: Point[]) {
  const n = points.length
  const at = (i: number) => points[(i + n) % n]
  const f = ([x, y]: Point) => `${x.toFixed(1)} ${y.toFixed(1)}`
  let d = `M${f(at(0))}`
  for (let i = 0; i < n; i++) {
    const [p0, p1, p2, p3] = [at(i - 1), at(i), at(i + 1), at(i + 2)]
    const c1: Point = [p1[0] + (p2[0] - p0[0]) / 6, p1[1] + (p2[1] - p0[1]) / 6]
    const c2: Point = [p2[0] - (p3[0] - p1[0]) / 6, p2[1] - (p3[1] - p1[1]) / 6]
    d += `C${f(c1)} ${f(c2)} ${f(p2)}`
  }
  return `${d}Z`
}

/** A slow, uneven radial wobble so no two bodies look machine-made. */
function wobble(theta: number, amount: number, seed: number) {
  return (
    amount *
    (0.6 * Math.sin(2 * theta + seed) +
      0.8 * Math.sin(3 * theta + 2.1 * seed) +
      0.4 * Math.sin(5 * theta + 3.7 * seed))
  )
}

interface ShapeSpec {
  cx: number
  cy: number
  /** Base radius. */
  r: number
  /** Number of lobes (3 = triangle, 4 = square…). 0 is a plain round blob. */
  sides?: number
  /** How far the corners push out: small values give soft polygons, large ones give a star. */
  corners?: number
  /** Sharpens the corners a little without ever making them pointed. */
  sharpen?: number
  /** Direction of the first corner, in degrees (-90 is straight up). */
  rotate?: number
  sx?: number
  sy?: number
  wobble?: number
  seed?: number
}

/**
 * A rounded polygon in polar form: r(θ) = 1 + a·cos(nθ) + b·cos(2nθ). It's a sum of cosines, so
 * the outline is smooth everywhere: corners become lobes and edges bow gently.
 */
function shape({
  cx,
  cy,
  r,
  sides = 0,
  corners = 0,
  sharpen = 0,
  rotate = -90,
  sx = 1,
  sy = 1,
  wobble: amount = 0.025,
  seed = 1,
}: ShapeSpec) {
  const rot = (rotate * Math.PI) / 180
  const points: Point[] = []
  const steps = 72
  for (let k = 0; k < steps; k++) {
    const theta = (2 * Math.PI * k) / steps
    const phi = theta - rot
    const radius =
      r *
      (1 +
        corners * Math.cos(sides * phi) +
        sharpen * Math.cos(2 * sides * phi) +
        wobble(theta, amount, seed))
    points.push([cx + radius * sx * Math.cos(theta), cy + radius * sy * Math.sin(theta)])
  }
  return smoothPath(points)
}

/**
 * A plump heart from the classic parametric heart. Its x term is usually sin³t, which pinches the
 * tip and the dip into cusps; blending in a linear sin t keeps both of them rounded.
 */
function heart(cx: number, cy: number, scale: number, seed: number) {
  const points: Point[] = []
  const steps = 72
  for (let k = 0; k < steps; k++) {
    const t = (2 * Math.PI * k) / steps
    const sin = Math.sin(t)
    const x = 16 * sin * (0.8 * sin * sin + 0.2)
    const y = -(13 * Math.cos(t) - 5 * Math.cos(2 * t) - 2 * Math.cos(3 * t) - Math.cos(4 * t))
    const w = 1 + wobble(t, 0.02, seed)
    points.push([cx + x * scale * w, cy + (y + 2) * scale * w])
  }
  return smoothPath(points)
}

/** Top-to-bottom glass gradient, used by bodies and accessories alike. */
function gradient(id: string, palette: Palette) {
  return (
    <linearGradient id={id} x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stopColor={palette.top} />
      <stop offset="0.55" stopColor={palette.base} />
      <stop offset="1" stopColor={palette.deep} />
    </linearGradient>
  )
}

/**
 * A glassy body: a soft vertical gradient, a lit inner rim along the top edge, a specular bloom
 * and a faint rim line. Everything inside is clipped to the outline so the glass reads as solid.
 */
function body(uid: string, palette: Palette, d: string) {
  return (
    <>
      <defs>
        {gradient(`${uid}-fill`, palette)}
        <radialGradient id={`${uid}-spec`} cx="0.38" cy="0.12" r="0.5">
          <stop offset="0" stopColor="#fff" stopOpacity="0.75" />
          <stop offset="1" stopColor="#fff" stopOpacity="0" />
        </radialGradient>
        <clipPath id={`${uid}-clip`}>
          <path d={d} />
        </clipPath>
      </defs>
      <path d={d} fill={`url(#${uid}-fill)`} />
      <g clipPath={`url(#${uid}-clip)`}>
        <path d={d} fill={`url(#${uid}-spec)`} />
        <path
          d={d}
          fill="none"
          stroke="#fff"
          strokeOpacity="0.6"
          strokeWidth="3"
          transform="translate(0 1.6)"
        />
        <path
          d={d}
          fill="none"
          stroke={palette.deep}
          strokeOpacity="0.35"
          strokeWidth="5"
          transform="translate(0 -2.5)"
        />
      </g>
      <path d={d} fill="none" stroke={palette.deep} strokeOpacity="0.45" strokeWidth="1" />
    </>
  )
}

/** Fill and edge props that give an accessory part the same glass finish as the bodies. */
function glass(id: string, palette: Palette) {
  return {
    fill: `url(#${id})`,
    stroke: palette.deep,
    strokeOpacity: 0.5,
    strokeWidth: 1,
  }
}

/** A soft white sheen across the top of an accessory part. */
function sheen(d: string) {
  return (
    <path
      d={d}
      stroke="#fff"
      strokeOpacity="0.7"
      strokeWidth="1.6"
      strokeLinecap="round"
      fill="none"
    />
  )
}

type EyeStyle = "pill" | "tall" | "dot" | "happy" | "sleepy" | "wink"

/** Minimal eyes in the shared ink, with a faint light rim like the glass around them. */
function eyes(style: EyeStyle, y: number, spread = 10) {
  const left = 50 - spread
  const right = 50 + spread
  const rim = { stroke: "#fff", strokeOpacity: 0.3, strokeWidth: 1 }
  const pill = (cx: number, w: number, h: number) => (
    <rect
      key={cx}
      x={cx - w / 2}
      y={y - h / 2}
      width={w}
      height={h}
      rx={w / 2}
      fill={INK}
      {...rim}
    />
  )
  const arc = (cx: number, up: boolean) => (
    <path
      key={cx}
      d={`M${cx - 4.5} ${y}q4.5 ${up ? -5 : 4} 9 0`}
      stroke={INK}
      strokeWidth="2.6"
      strokeLinecap="round"
      fill="none"
    />
  )
  switch (style) {
    case "pill":
      return <g className="bot-blink">{[pill(left, 5, 10), pill(right, 5, 10)]}</g>
    case "tall":
      return <g className="bot-blink">{[pill(left, 5.5, 13), pill(right, 5.5, 13)]}</g>
    case "dot":
      return (
        <g className="bot-blink" fill={INK} {...rim}>
          <circle cx={left} cy={y} r="3.2" />
          <circle cx={right} cy={y} r="3.2" />
        </g>
      )
    case "happy":
      return <g>{[arc(left, true), arc(right, true)]}</g>
    case "sleepy":
      return <g>{[arc(left, false), arc(right, false)]}</g>
    case "wink":
      return (
        <g>
          {arc(left, true)}
          <g className="bot-blink">{pill(right, 5, 10)}</g>
        </g>
      )
  }
}

const tri: Palette = { top: "#e4faf0", base: "#a8e6cb", deep: "#5eb593" }
const cubby: Palette = { top: "#eeeaff", base: "#c3b6ff", deep: "#8775dc" }
const penny: Palette = { top: "#ffece3", base: "#ffc6ab", deep: "#de8c6c" }
const hex: Palette = { top: "#e6f3ff", base: "#aed6ff", deep: "#6aa2dc" }
const stella: Palette = { top: "#fff6d9", base: "#ffe196", deep: "#d6a647" }
const orbi: Palette = { top: "#ffe9f0", base: "#ffbccd", deep: "#de7f9a" }
const gem: Palette = { top: "#e0f8f5", base: "#a3e3db", deep: "#58b0a5" }
const bloom: Palette = { top: "#f6e9ff", base: "#ddbdf5", deep: "#a57cc6" }

/** Accessory accents, picked to sit next to each body without clashing. */
const beanie: Palette = { top: "#e1ecff", base: "#a9c4f2", deep: "#6c8fcc" }
const cap: Palette = { top: "#fff3d6", base: "#ffd98c", deep: "#d4a24a" }
const crown: Palette = { top: "#f1ebff", base: "#cdbdff", deep: "#8f78dc" }
const bow: Palette = { top: "#efe9ff", base: "#c4b3f7", deep: "#8a72d4" }
const bulb: Palette = { top: "#fffbe6", base: "#ffe58a", deep: "#d9b23f" }
const petals: Palette = { top: "#ffffff", base: "#fde6ef", deep: "#d6a0b6" }

const TRI = shape({ cx: 50, cy: 61, r: 31, sides: 3, corners: 0.2, sharpen: 0.045, seed: 1.3 })
const CUBBY = shape({
  cx: 50,
  cy: 60,
  r: 33,
  sides: 4,
  corners: 0.07,
  sharpen: 0.015,
  rotate: -45,
  seed: 2.2,
})
// Flat side up, so the beanie sits on it and both shoulders stay visible.
const PENNY = shape({
  cx: 50,
  cy: 59,
  r: 33,
  sides: 5,
  corners: 0.07,
  sharpen: 0.012,
  rotate: 90,
  seed: 0.7,
})
const HEX = shape({
  cx: 50,
  cy: 61,
  r: 32,
  sides: 6,
  corners: 0.05,
  sharpen: 0.01,
  rotate: 0,
  seed: 3.1,
})
const STELLA = shape({ cx: 50, cy: 60, r: 29, sides: 5, corners: 0.27, sharpen: 0.05, seed: 1.9 })
const ORBI = shape({ cx: 50, cy: 60, r: 31, wobble: 0.045, seed: 4.4 })
const GEM = shape({
  cx: 50,
  cy: 61,
  r: 28,
  sides: 4,
  corners: 0.12,
  sharpen: 0.02,
  sx: 0.95,
  sy: 1.12,
  seed: 2.7,
})
const BLOOM = heart(50, 60, 1.85, 5.3)

export const BOTS: BotDefinition[] = [
  {
    id: "tri",
    name: "Tri",
    description:
      "A soft little triangle who tilts its head left, then right, and reads everything twice.",
    draw: (uid) => (
      <g className="bot-breathe">
        {body(uid, tri, TRI)}
        {eyes("dot", 60, 9)}
        <g stroke={GRAPHITE.base} strokeWidth="2" strokeLinecap="round">
          <circle cx="41" cy="60" r="7.5" fill="#fff" fillOpacity="0.22" />
          <circle cx="59" cy="60" r="7.5" fill="#fff" fillOpacity="0.22" />
          <path d="M48.5 59q1.5-2 3 0" fill="none" />
          <path d="M33.5 58q-2.5-1-4.5 0.5M66.5 58q2.5-1 4.5 0.5" fill="none" />
        </g>
        {sheen("M36.5 56q2-2 4.5-2")}
        {sheen("M54.5 56q2-2 4.5-2")}
      </g>
    ),
  },
  {
    id: "cubby",
    name: "Cubby",
    description: "A squishy square with a happy squint who jiggles whenever it's pleased.",
    draw: (uid) => (
      <g className="bot-jiggle">
        {body(uid, cubby, CUBBY)}
        {eyes("pill", 60, 11)}
        <defs>
          {gradient(`${uid}-hat`, beanie)}
          {gradient(`${uid}-pom`, FROST)}
        </defs>
        {/* Widened to cover the square's shoulders. */}
        <g transform="translate(50 0) scale(1.16 1) translate(-50 0)">
          <path d="M27 40C26 13 74 13 73 40C61 36 39 36 27 40Z" {...glass(`${uid}-hat`, beanie)} />
          <path
            d="M23 40C37 34 63 34 77 40C78 46 74 48 70 46C58 42 42 42 30 46C26 48 22 46 23 40Z"
            {...glass(`${uid}-hat`, beanie)}
          />
          <path
            d="M39 21q-2 7-1 15M50 18v17M61 21q2 7 1 15"
            stroke={beanie.deep}
            strokeOpacity="0.35"
            strokeWidth="1.4"
            strokeLinecap="round"
            fill="none"
          />
          {sheen("M34 31q6-9 15-10")}
        </g>
        <circle cx="50" cy="12" r="5.5" {...glass(`${uid}-pom`, FROST)} />
      </g>
    ),
  },
  {
    id: "penny",
    name: "Penny",
    description: "A cheeky coral blob with a wink who bobs along to a beat only it can hear.",
    draw: (uid) => (
      <g className="bot-breathe">
        {body(uid, penny, PENNY)}
        {eyes("happy", 58, 10)}
        <defs>
          {gradient(`${uid}-band`, GRAPHITE)}
          {gradient(`${uid}-cup`, FROST)}
        </defs>
        <path
          d="M19 52C14 6 86 6 81 52"
          stroke={`url(#${uid}-band)`}
          strokeWidth="4"
          strokeLinecap="round"
          fill="none"
        />
        <rect x="12" y="45" width="13" height="19" rx="6.5" {...glass(`${uid}-cup`, FROST)} />
        <rect x="75" y="45" width="13" height="19" rx="6.5" {...glass(`${uid}-cup`, FROST)} />
        {sheen("M15.5 50q3-3 6 0")}
        {sheen("M78.5 50q3-3 6 0")}
      </g>
    ),
  },
  {
    id: "hex",
    name: "Hex",
    description: "A calm blue hexagon that hovers quietly and glows when it has an idea.",
    draw: (uid) => (
      <>
        <defs>{gradient(`${uid}-bulb`, bulb)}</defs>
        <g className="bot-antenna">
          <path
            d="M50 32C48 26 53 22 51.5 16"
            stroke={hex.deep}
            strokeWidth="2.2"
            strokeLinecap="round"
            fill="none"
          />
          <circle
            className="bot-glow"
            cx="51.5"
            cy="13.5"
            r="4.6"
            {...glass(`${uid}-bulb`, bulb)}
          />
          <circle cx="50.2" cy="12" r="1.4" fill="#fff" opacity="0.85" />
        </g>
        <g className="bot-breathe">
          {body(uid, hex, HEX)}
          {eyes("tall", 61, 10)}
        </g>
      </>
    ),
  },
  {
    id: "stella",
    name: "Stella",
    description: "A sunny little star that wiggles and twinkles like it knows something you don't.",
    draw: (uid) => (
      <g className="bot-wiggle">
        {body(uid, stella, STELLA)}
        {eyes("wink", 61, 9)}
        <defs>{gradient(`${uid}-crown`, crown)}</defs>
        <path
          d="M39 26C38 19 40 14 41 11C44 15 46 16 50 8C54 16 56 15 59 11C60 14 62 19 61 26C55 23.5 45 23.5 39 26Z"
          {...glass(`${uid}-crown`, crown)}
          strokeLinejoin="round"
        />
        {sheen("M42 21q8-3 16 0")}
      </g>
    ),
  },
  {
    id: "orbi",
    name: "Orbi",
    description: "A round, wobbly blob who drifts and pulses like a jellyfish.",
    draw: (uid) => (
      <g className="bot-float">
        {body(uid, orbi, ORBI)}
        {eyes("pill", 60, 11)}
        <defs>{gradient(`${uid}-bow`, bow)}</defs>
        <g className="bot-bow">
          <path d="M50 30C43 19 30 21 31 30C32 37 42 37 50 31Z" {...glass(`${uid}-bow`, bow)} />
          <path d="M50 30C57 19 70 21 69 30C68 37 58 37 50 31Z" {...glass(`${uid}-bow`, bow)} />
          {sheen("M35 26q4-3.5 8-1.5")}
          {sheen("M65 26q-4-3.5-8-1.5")}
          <ellipse cx="50" cy="30.5" rx="4" ry="3.8" {...glass(`${uid}-bow`, bow)} />
        </g>
      </g>
    ),
  },
  {
    id: "gem",
    name: "Gem",
    description:
      "A plump purple diamond that floats up and does a full flip when it's thinking hard.",
    draw: (uid) => (
      <g className="bot-float">
        {body(uid, gem, GEM)}
        {eyes("dot", 61, 9)}
        <defs>
          {gradient(`${uid}-cap`, cap)}
          {gradient(`${uid}-blade`, FROST)}
        </defs>
        {/* Scaled down to perch on the diamond's tip. */}
        <g transform="translate(50 37) scale(0.82) translate(-50 -40)">
          <path d="M31 38C31 19 69 19 69 38C57 34 43 34 31 38Z" {...glass(`${uid}-cap`, cap)} />
          <path
            d="M31 38C43 34 57 34 69 38Q76 41 71 42C59 38 41 38 29 42Q24 41 31 38Z"
            {...glass(`${uid}-cap`, cap)}
          />
          {sheen("M37 33q5-7 12-8")}
          <path d="M50 22v-6" stroke={GRAPHITE.base} strokeWidth="2" strokeLinecap="round" />
          <g className="bot-propel">
            <ellipse cx="41" cy="14" rx="8.5" ry="2.6" {...glass(`${uid}-blade`, FROST)} />
            <ellipse cx="59" cy="14" rx="8.5" ry="2.6" {...glass(`${uid}-blade`, FROST)} />
          </g>
          <circle cx="50" cy="14.5" r="2" fill={GRAPHITE.base} />
        </g>
      </g>
    ),
  },
  {
    id: "bloom",
    name: "Bloom",
    description: "A gentle heart whose glow beats softly, in time with a heart of its own.",
    draw: (uid) => (
      <>
        <defs>
          {gradient(`${uid}-petal`, petals)}
          {gradient(`${uid}-leaf`, tri)}
          {gradient(`${uid}-heart`, stella)}
        </defs>
        <g className="bot-antenna">
          <path
            d="M50 34C50 28 48 25 50 20"
            stroke={tri.deep}
            strokeWidth="2"
            strokeLinecap="round"
            fill="none"
          />
          <path
            d="M50 29C53 25.5 58 26 59.5 27.5C57 30.5 53 30.5 50 29Z"
            {...glass(`${uid}-leaf`, tri)}
          />
          {[0, 72, 144, 216, 288].map((angle) => (
            <ellipse
              key={angle}
              cx="50"
              cy="9.5"
              rx="3.6"
              ry="5"
              transform={`rotate(${angle} 50 15)`}
              {...glass(`${uid}-petal`, petals)}
            />
          ))}
          <circle cx="50" cy="15" r="3.2" {...glass(`${uid}-heart`, stella)} />
        </g>
        <g className="bot-breathe">
          {body(uid, bloom, BLOOM)}
          {eyes("sleepy", 58, 10)}
        </g>
      </>
    ),
  },
]

/** Older builds stored these ids; v3 of the database maps them onto the current bots. */
export const LEGACY_BOT_IDS: Record<string, string> = {
  bolt: "cubby",
  ember: "tri",
  custard: "penny",
  nimbus: "orbi",
  sprout: "gem",
  twinkle: "stella",
  bubbles: "hex",
  mochi: "bloom",
}

/** The bot Memento uses wherever no profile is in play. */
export const DEFAULT_BOT_ID = "cubby"

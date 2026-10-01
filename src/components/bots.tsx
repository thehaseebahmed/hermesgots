import type { ReactNode } from "react"

/**
 * Memento's bot characters (rendered by <Bot> in bot.tsx): fluffy SVG buddies with a fur filter and soft 3D shading.
 * Each is still by default; pass `animate` (the header does) to bring it to life.
 * Animations live in index.css under `.bot-animate` and respect prefers-reduced-motion.
 */

interface Palette {
  light: string
  base: string
  dark: string
}

interface BotDefinition {
  id: string
  name: string
  description: string
  draw: (ids: { fur: string; fill: string }) => ReactNode
}

const INK = "#16161a"

/** Gradient + fur filter shared by every character. */
function furDefs(fur: string, fill: string, palette: Palette) {
  return (
    <defs>
      <radialGradient id={fill} cx="34%" cy="28%" r="80%">
        <stop offset="0" stopColor={palette.light} />
        <stop offset="0.5" stopColor={palette.base} />
        <stop offset="1" stopColor={palette.dark} />
      </radialGradient>
      <filter id={fur} x="-15%" y="-15%" width="130%" height="130%">
        <feTurbulence
          type="fractalNoise"
          baseFrequency="0.9"
          numOctaves="2"
          seed="7"
          result="noise"
        />
        <feDisplacementMap
          in="SourceGraphic"
          in2="noise"
          scale="5"
          xChannelSelector="R"
          yChannelSelector="G"
          result="fuzzy"
        />
        <feTurbulence
          type="fractalNoise"
          baseFrequency="2.2"
          numOctaves="1"
          seed="3"
          result="grain"
        />
        <feColorMatrix
          in="grain"
          type="matrix"
          values="0 0 0 0 1  0 0 0 0 1  0 0 0 0 1  0 0 0 0.55 -0.25"
          result="sheen"
        />
        <feComposite in="sheen" in2="fuzzy" operator="in" result="sheenOnBody" />
        <feMerge>
          <feMergeNode in="fuzzy" />
          <feMergeNode in="sheenOnBody" />
        </feMerge>
      </filter>
    </defs>
  )
}

function glint(cx: number, cy: number, r = 1.6) {
  return <circle key={`${cx}-${cy}`} cx={cx} cy={cy} r={r} fill="#fff" />
}

const bolt: Palette = { light: "#e2dcff", base: "#9b8cff", dark: "#5a48d4" }
const ember: Palette = { light: "#ffd6c2", base: "#ff7a59", dark: "#d93f26" }
const custard: Palette = { light: "#fff4d6", base: "#ffd98f", dark: "#e0a64a" }
const nimbus: Palette = { light: "#e6ebff", base: "#a9b8ff", dark: "#6a7fe0" }
const sprout: Palette = { light: "#c9ffe6", base: "#5ee6a8", dark: "#1aa86c" }
const twinkle: Palette = { light: "#ffe0b0", base: "#ffa43b", dark: "#dc6a00" }
const bubbles: Palette = { light: "#c4f6ff", base: "#4fd1e8", dark: "#128fae" }
const mochi: Palette = { light: "#fff0e2", base: "#ffbd8f", dark: "#e3834a" }

/** Five-point star with rounded tips (round line joins on a same-colour stroke). */
const STAR = (() => {
  const points: string[] = []
  for (let i = 0; i < 10; i++) {
    const r = i % 2 === 0 ? 40 : 20
    const a = (Math.PI / 5) * i - Math.PI / 2
    points.push(`${(50 + r * Math.cos(a)).toFixed(1)},${(56 + r * Math.sin(a)).toFixed(1)}`)
  }
  return `M${points.join(" L")}Z`
})()

export const BOTS: BotDefinition[] = [
  {
    id: "bolt",
    name: "Bolt",
    description: "A tidy little bot whose visor eyes scan back and forth while it thinks.",
    draw: ({ fur, fill }) => (
      <>
        {furDefs(fur, fill, bolt)}
        <g className="bot-breathe">
          <g filter={`url(#${fur})`} fill={`url(#${fill})`}>
            <rect x="14" y="20" width="72" height="72" rx="26" />
            <circle cx="12" cy="56" r="7" />
            <circle cx="88" cy="56" r="7" />
          </g>
          {/* visor */}
          <rect
            x="22"
            y="40"
            width="56"
            height="26"
            rx="13"
            fill={INK}
            stroke="#fff"
            strokeOpacity="0.25"
            strokeWidth="1.5"
          />
          <g className="bot-scan">
            <g className="bot-blink">
              <rect x="33" y="46" width="8" height="14" rx="4" fill="#7df9ff" />
              <rect x="59" y="46" width="8" height="14" rx="4" fill="#7df9ff" />
            </g>
          </g>
          <path
            d="M28 44q10-4 20-3"
            stroke="#fff"
            strokeOpacity="0.3"
            strokeWidth="2"
            fill="none"
            strokeLinecap="round"
          />
          <path
            d="M43 76q7 5 14 0"
            stroke={INK}
            strokeWidth="3"
            strokeLinecap="round"
            fill="none"
          />
        </g>
      </>
    ),
  },
  {
    id: "ember",
    name: "Ember",
    description: "A warm little flame that flickers with excitement.",
    draw: ({ fur, fill }) => (
      <>
        {furDefs(fur, fill, ember)}
        <g className="bot-flicker">
          <path
            filter={`url(#${fur})`}
            fill={`url(#${fill})`}
            d="M50 6C58 22 78 32 81 54C84 78 68 94 50 94C32 94 16 80 19 58C21 46 29 41 33 30C37 39 41 42 44 45C44 31 46 19 50 6Z"
          />
          <path
            d="M50 52C55 60 64 64 64 74C64 83 58 88 50 88C42 88 36 83 36 75C36 68 42 64 44 58C46 62 48 63 50 64Z"
            fill="#ffd36b"
            opacity="0.85"
          />
          <g className="bot-blink">
            <ellipse cx="40" cy="60" rx="4.5" ry="6" fill={INK} />
            <ellipse cx="60" cy="60" rx="4.5" ry="6" fill={INK} />
            {glint(41.6, 57.6)}
            {glint(61.6, 57.6)}
          </g>
          <path
            d="M45 71q5 6 10 0Z"
            fill={INK}
            strokeLinejoin="round"
            stroke={INK}
            strokeWidth="2"
          />
        </g>
      </>
    ),
  },
  {
    id: "custard",
    name: "Custard",
    description: "A wobbly caramel pudding, cherry on top, that jiggles when it's happy.",
    draw: ({ fur, fill }) => (
      <>
        {furDefs(fur, fill, custard)}
        <g className="bot-jiggle">
          <path
            filter={`url(#${fur})`}
            fill={`url(#${fill})`}
            d="M24 42Q24 30 50 30Q76 30 76 42L84 82Q84 92 50 92Q16 92 16 82Z"
          />
          <path
            d="M24 44Q24 30 50 30Q76 30 76 44Q73 53 69 47Q64 57 58 47Q52 55 46 47Q40 57 34 47Q28 53 24 44Z"
            fill="#9a5424"
          />
          <path
            d="M32 38q8-4 16-4"
            stroke="#fff"
            strokeOpacity="0.35"
            strokeWidth="2.5"
            fill="none"
            strokeLinecap="round"
          />
          <path
            d="M50 22q3-9 10-12"
            stroke="#4d7a2a"
            strokeWidth="2.5"
            fill="none"
            strokeLinecap="round"
          />
          <circle cx="50" cy="25" r="7" fill="#e5243b" />
          <circle cx="47.5" cy="22.5" r="2" fill="#fff" opacity="0.6" />
          <g className="bot-blink">
            <circle cx="39" cy="66" r="4.2" fill={INK} />
            <circle cx="61" cy="66" r="4.2" fill={INK} />
            {glint(40.4, 64.4, 1.3)}
            {glint(62.4, 64.4, 1.3)}
          </g>
          <ellipse cx="32" cy="74" rx="4.5" ry="2.6" fill="#ff7a8a" opacity="0.45" />
          <ellipse cx="68" cy="74" rx="4.5" ry="2.6" fill="#ff7a8a" opacity="0.45" />
          <path
            d="M46 73q4 4 8 0"
            stroke={INK}
            strokeWidth="2.6"
            strokeLinecap="round"
            fill="none"
          />
        </g>
      </>
    ),
  },
  {
    id: "nimbus",
    name: "Nimbus",
    description: "A sleepy little cloud that breathes slow and dreams in Zs.",
    draw: ({ fur, fill }) => (
      <>
        {furDefs(fur, fill, nimbus)}
        <g className="bot-breathe">
          <g filter={`url(#${fur})`} fill={`url(#${fill})`}>
            <circle cx="30" cy="62" r="18" />
            <circle cx="47" cy="44" r="22" />
            <circle cx="68" cy="52" r="18" />
            <circle cx="74" cy="68" r="15" />
            <rect x="22" y="58" width="58" height="26" rx="13" />
          </g>
          <path
            d="M36 64q5 4 10 0M56 64q5 4 10 0"
            stroke={INK}
            strokeWidth="3.2"
            strokeLinecap="round"
            fill="none"
          />
          <ellipse cx="51" cy="74" rx="2.6" ry="3" fill={INK} />
        </g>
        <g
          className="bot-zzz"
          fill="currentColor"
          fontFamily="ui-rounded, system-ui, sans-serif"
          fontWeight="800"
        >
          <text x="80" y="30" fontSize="12">
            z
          </text>
          <text x="88" y="18" fontSize="9">
            z
          </text>
        </g>
      </>
    ),
  },
  {
    id: "sprout",
    name: "Sprout",
    description: "Eager helper with an antenna that wiggles when it has an idea.",
    draw: ({ fur, fill }) => (
      <>
        {furDefs(fur, fill, sprout)}
        <g className="bot-antenna">
          <path d="M50 26V9" stroke={sprout.dark} strokeWidth="3" strokeLinecap="round" />
          <circle className="bot-glow" cx="50" cy="8" r="5.5" fill="#ffe066" />
        </g>
        <path
          filter={`url(#${fur})`}
          fill={`url(#${fill})`}
          d="M20 46C20 30 32 22 50 22C68 22 80 30 80 46L83 72C83 87 70 93 50 93C30 93 17 87 17 72Z"
        />
        <g className="bot-blink">
          <ellipse cx="38" cy="55" rx="6.5" ry="8.5" fill={INK} />
          <ellipse cx="62" cy="55" rx="6.5" ry="8.5" fill={INK} />
          {glint(40, 51.5, 2.2)}
          {glint(64, 51.5, 2.2)}
        </g>
        <path d="M44 71q6 5 12 0" stroke={INK} strokeWidth="3" strokeLinecap="round" fill="none" />
      </>
    ),
  },
  {
    id: "twinkle",
    name: "Twinkle",
    description: "A cheeky star that winks and wiggles between sparkles.",
    draw: ({ fur, fill }) => (
      <>
        {furDefs(fur, fill, twinkle)}
        <g className="bot-wiggle">
          <path
            filter={`url(#${fur})`}
            fill={`url(#${fill})`}
            stroke={`url(#${fill})`}
            strokeWidth="9"
            strokeLinejoin="round"
            d={STAR}
          />
          <path
            d="M36 58q5-5 10 0"
            stroke={INK}
            strokeWidth="3.2"
            strokeLinecap="round"
            fill="none"
          />
          <ellipse cx="60" cy="57" rx="4.2" ry="5.8" fill={INK} />
          {glint(61.4, 54.8, 1.4)}
          <ellipse cx="36" cy="67" rx="4.5" ry="2.6" fill="#ff5f7a" opacity="0.5" />
          <ellipse cx="64" cy="67" rx="4.5" ry="2.6" fill="#ff5f7a" opacity="0.5" />
          <path
            d="M47 67q3 3 6 0"
            stroke={INK}
            strokeWidth="2.6"
            strokeLinecap="round"
            fill="none"
          />
        </g>
        <g className="bot-sparkle" fill="#ffd43b">
          <path d="M88 14l2.5 6 6 2.5-6 2.5-2.5 6-2.5-6-6-2.5 6-2.5Z" />
          <path d="M10 18l1.6 4 4 1.6-4 1.6-1.6 4-1.6-4-4-1.6 4-1.6Z" />
        </g>
      </>
    ),
  },
  {
    id: "bubbles",
    name: "Bubbles",
    description: "A floaty friend who drifts up and down, blinking big eyes.",
    draw: ({ fur, fill }) => (
      <>
        {furDefs(fur, fill, bubbles)}
        <g className="bot-float">
          <path
            filter={`url(#${fur})`}
            fill={`url(#${fill})`}
            d="M18 50C18 28 32 12 50 12C68 12 82 28 82 50V84Q74 92 66 84T50 84T34 84T18 84Z"
          />
          <g className="bot-blink">
            <circle cx="38" cy="48" r="7" fill={INK} />
            <circle cx="62" cy="48" r="7" fill={INK} />
            {glint(40.4, 45.4, 2.4)}
            {glint(64.4, 45.4, 2.4)}
          </g>
          <ellipse cx="50" cy="63" rx="4" ry="4.8" fill={INK} />
        </g>
      </>
    ),
  },
  {
    id: "mochi",
    name: "Mochi",
    description: "A soft kitten-ish puff whose ear twitches when it's listening.",
    draw: ({ fur, fill }) => (
      <>
        {furDefs(fur, fill, mochi)}
        <g filter={`url(#${fur})`} fill={`url(#${fill})`}>
          <path
            d="M20 46 24 12 46 30Z"
            strokeLinejoin="round"
            stroke={mochi.base}
            strokeWidth="5"
          />
          <path
            className="bot-ear"
            d="M80 46 76 12 54 30Z"
            strokeLinejoin="round"
            stroke={mochi.base}
            strokeWidth="5"
          />
          <circle cx="50" cy="60" r="34" />
        </g>
        <g className="bot-blink">
          <ellipse cx="38" cy="58" rx="4.5" ry="6" fill={INK} />
          <ellipse cx="62" cy="58" rx="4.5" ry="6" fill={INK} />
          {glint(39.6, 55.6)}
          {glint(63.6, 55.6)}
        </g>
        <path
          d="M47 67h6l-3 3.5Z"
          fill="#ff6f8f"
          strokeLinejoin="round"
          stroke="#ff6f8f"
          strokeWidth="1.5"
        />
        <path
          d="M14 64l14 2M14 72l14-2M86 64l-14 2M86 72l-14-2"
          stroke={INK}
          strokeWidth="1.6"
          strokeLinecap="round"
          opacity="0.6"
        />
      </>
    ),
  },
]

/** The bot Memento uses everywhere. Hardcoded for now; the others are in /bots. */
export const DEFAULT_BOT_ID = "bolt"

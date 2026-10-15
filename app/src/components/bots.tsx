/**
 * Gots's bot characters. The artwork lives in public/bots/<id>.png and <Bot> (bot.tsx) renders
 * it; each one's motion is `.bot-anim-<id>` in index.css, which only runs under `.bot-animate`.
 */

interface BotDefinition {
  id: string
  name: string
  description: string
}

export const BOTS: BotDefinition[] = [
  {
    id: "tri",
    name: "Tri",
    description:
      "A soft little triangle who tilts its head left, then right, and reads everything twice.",
  },
  {
    id: "cubby",
    name: "Cubby",
    description: "A squishy square with a happy squint who jiggles whenever it's pleased.",
  },
  {
    id: "penny",
    name: "Penny",
    description: "A cheeky coral blob with a wink who bobs along to a beat only it can hear.",
  },
  {
    id: "hex",
    name: "Hex",
    description: "A calm blue hexagon that hovers quietly and glows when it has an idea.",
  },
  {
    id: "stella",
    name: "Stella",
    description: "A sunny little star that wiggles and twinkles like it knows something you don't.",
  },
  {
    id: "orbi",
    name: "Orbi",
    description: "A round, wobbly blob who drifts and pulses like a jellyfish.",
  },
  {
    id: "gem",
    name: "Gem",
    description:
      "A plump purple diamond that floats up and does a full flip when it's thinking hard.",
  },
  {
    id: "bloom",
    name: "Bloom",
    description: "A gentle heart whose glow beats softly, in time with a heart of its own.",
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

/** The bot Gots uses wherever no profile is in play. */
export const DEFAULT_BOT_ID = "cubby"

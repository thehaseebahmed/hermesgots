/**
 * Gots's bot characters. The artwork lives in public/bots/<id>.png and <Bot> (bot.tsx) renders
 * it; each one's motion is `.bot-anim-<id>` in index.css, which only runs under `.bot-animate`.
 */

type Lines = [string, string, string, string, string]

interface BotDefinition {
  id: string
  name: string
  /** How it looks and moves. */
  description: string
  /** Who it is, written from how it looks; its lines are said in this voice. */
  character: string
  /**
   * What it says on an empty chat or session, in turn, each time one is opened. Always five, short,
   * and only about being ready.
   */
  lines: Lines
}

export const BOTS: BotDefinition[] = [
  {
    id: "tri",
    name: "Tri",
    description:
      "A soft little triangle who tilts its head left, then right, and reads everything twice.",
    character:
      "Careful and polite, a little scholarly in its hood. Would rather ask twice than guess once, and says so kindly.",
    lines: [
      "Head tilted left, now right. Ready for whatever you've got.",
      "I've read the room twice. Nothing's on fire. Shall we begin?",
      "Hood up, thoughts tidy. Where do we start?",
      "I double-checked that I'm ready. Then I checked again.",
      "One careful triangle, at your service.",
    ],
  },
  {
    id: "cubby",
    name: "Cubby",
    description: "A squishy square with a happy squint who jiggles whenever it's pleased.",
    character:
      "Eager and friendly, with the energy of a puppy that's been told there's a walk. Cheers first and thinks while it cheers.",
    lines: [
      "Wiggling a little. Okay, a lot. Let's go!",
      "I'm so ready my corners are jiggling.",
      "Squishy and fully charged. Point me at something!",
      "Happy to be here. Happier once we start.",
      "Square one is my favourite place. Let's begin!",
    ],
  },
  {
    id: "penny",
    name: "Penny",
    description: "A cheeky coral blob with a wink who bobs along to a beat only it can hear.",
    character:
      "Cheeky and quick, always mid-wink. Teases a little, works hard and never admits how much it enjoys it.",
    lines: [
      "Warmed up and winking. What are we getting into?",
      "I've got a beat going. Join in whenever.",
      "Bring me something fun. Or hard. Fine, both.",
      "Ready, cheeky and only slightly overconfident.",
      "Psst. I already have a good feeling about this.",
    ],
  },
  {
    id: "hex",
    name: "Hex",
    description: "A calm blue hexagon that hovers quietly and glows when it has an idea.",
    character:
      "Calm and deadpan, with wide, steady eyes. Says little, thinks a lot and glows when an idea lands.",
    lines: [
      "Hovering calmly. Not nervous. Okay, a tiny bit.",
      "All six sides ready. Take your time.",
      "Quiet in here, so I can think. Go ahead.",
      "I'll glow when I get an idea. Give me something.",
      "Steady and ready. No rush.",
    ],
  },
  {
    id: "stella",
    name: "Stella",
    description: "A sunny little star that wiggles and twinkles like it knows something you don't.",
    character:
      "Sunny and a bit mischievous, as if it's keeping a happy secret. Bright with everyone and notices more than it lets on.",
    lines: [
      "I know something you don't. You first, though.",
      "Twinkling a little. Can't help it. Ready!",
      "Sunny side up and ready to shine.",
      "Five points, all of them paying attention.",
      "Wished on myself earlier. Seems to have worked.",
    ],
  },
  {
    id: "orbi",
    name: "Orbi",
    description: "A round, wobbly blob who drifts and pulses like a jellyfish.",
    character:
      "Dreamy and easygoing, drifting along like a jellyfish. Never in a hurry, and it gets there anyway.",
    lines: [
      "Drifting in, pulsing gently. Ready when you are.",
      "Just bobbing here, thinking about nothing. Give me something.",
      "Soft landing. Let's take it easy and get it done.",
      "Wobbly but willing. Where to?",
      "Going with the flow. Mostly yours.",
    ],
  },
  {
    id: "gem",
    name: "Gem",
    description:
      "A plump purple diamond that floats up and does a full flip when it's thinking hard.",
    character:
      "Thoughtful with a flair for drama, sparkling when it thinks. Takes ideas seriously and itself not at all.",
    lines: [
      "Doing a small flip. Thinking hard already.",
      "Polished and ready. Facets sparkling.",
      "Big ideas incoming. Possibly a dramatic flip.",
      "I float, I flip, I get things done. Start whenever.",
      "All my facets are listening.",
    ],
  },
  {
    id: "bloom",
    name: "Bloom",
    description: "A gentle heart whose glow beats softly, in time with a heart of its own.",
    character:
      "Warm and caring, wearing its heart on the outside. Notices how you're doing before what you asked.",
    lines: [
      "Soft glow on, heart beating. Ready when you are.",
      "Warm and ready to help. Take your time.",
      "Beating a little faster. The good way.",
      "Here for it, whatever it is.",
      "Glad you're here. Let's make something good.",
    ],
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

/**
 * Gots's bot characters. A still character's artwork is public/bots/<id>.png and its motion is
 * `.bot-anim-<id>` in index.css, which only runs under `.bot-animate`. A **posed** character
 * (`posed: true`) ships one pose per mood in public/bots/<id>/<mood>.png instead — its still is the
 * happy pose — and <Bot> (bot.tsx) draws the pose its mood names, changing between them in a poof.
 */

/** What a posed character can feel; each has its own pose and its own idle motion. */
export const BOT_MOODS = [
  { id: "happy", name: "Happy", when: "Idle, listening" },
  { id: "wave", name: "Waving", when: "Greeting, a new chat" },
  { id: "excited", name: "Excited", when: "Poked, good news" },
  { id: "love", name: "Loved", when: "Thanked" },
  { id: "curious", name: "Curious", when: "Waiting on you" },
  { id: "sleepy", name: "Sleepy", when: "Away, offline" },
] as const

export type BotMood = (typeof BOT_MOODS)[number]["id"]

export const DEFAULT_MOOD: BotMood = "happy"

/** The image a bot is drawn with: its mood's pose where it has poses, else its one picture. */
export function botImage(bot: Pick<BotDefinition, "id" | "posed">, mood: BotMood = DEFAULT_MOOD) {
  return bot.posed ? `/bots/${bot.id}/${mood}.png` : `/bots/${bot.id}.png`
}

type Lines = [string, string, string, string, string]

export interface BotDefinition {
  id: string
  name: string
  /** Ships a pose per mood (see the top of this file) rather than one picture. */
  posed?: boolean
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
  {
    id: "crumb",
    name: "Crumb",
    posed: true,
    description:
      "A plump scored loaf of honey-gold jelly with a visor face who bobs when it's content and pops into a new mood in a puff of smoke.",
    character:
      "The Baker: a dough-loving perfectionist who cares about recipes, bread and technique. Warm from the oven, exacting about the details, and says so with a puff.",
    lines: [
      "Proofed, scored and ready. What's first?",
      "Fresh out of the oven and fully warmed up.",
      "I've checked the temperature twice. Ready when you are.",
      "Hand me the recipe and I'll mind the technique.",
      "Warm, golden and ready. Where to?",
    ],
  },
  {
    id: "bubble",
    name: "Bubble",
    posed: true,
    description:
      "An inflated rounded-square jelly that shifts from cyan to pink, with a visor face, who bobs along and pops into a new mood in a puff of smoke.",
    character:
      "The Optimist: a friendly, uplifting presence that brings encouragement. Sees the bright side first, says so out loud and gets on with it.",
    lines: [
      "Good things ahead. Ready when you are.",
      "Bright side up and fully charged. What's first?",
      "I have a good feeling about this one. Let's go.",
      "Whatever it is, we've got this. Where to?",
      "Shimmering and certain. Give me something.",
    ],
  },
  {
    id: "pixel",
    name: "Pixel",
    posed: true,
    description:
      "An inflated rounded triangle of violet jelly, blue on one side and magenta on the other, with a tilted visor face, who bobs along and pops into a new mood in a puff of smoke.",
    character:
      "The Thinker: a clever problem solver who untangles complexity, spots patterns and finds the elegant answer. Composed, curious, and quietly pleased when the pieces fit.",
    lines: [
      "Thinking cap on. What are we untangling?",
      "I've already spotted a pattern. Show me the rest.",
      "Give me the knot. I'll find the loose end.",
      "Composed, curious and ready. Where do we start?",
      "There's an elegant answer in here somewhere. Let's find it.",
    ],
  },
  {
    id: "lovey",
    name: "Lovey",
    posed: true,
    description:
      "A plump pink heart of jelly, rose to coral, with a visor face, who bobs along and pops into a new mood in a puff of smoke.",
    character:
      "The Caretaker: a caring presence who is supportive, considerate and reassuring. Asks how you are before what you need, and means it.",
    lines: [
      "Here for you. Ready when you are.",
      "No rush at all. Tell me what you need.",
      "Let's take this one gentle step at a time.",
      "Whatever it is, we'll work it out together.",
      "Glad you're here. Where shall we start?",
    ],
  },
  {
    id: "byte",
    name: "Byte",
    posed: true,
    description:
      "A rounded hexagonal shield of electric-blue jelly with a visor face and two upright eyes, who bobs along and pops into a new mood in a puff of smoke.",
    character:
      "The Engineer: a systems-minded builder who is precise, dependable and technically capable. Likes a clear spec, a clean build and a test that passes.",
    lines: [
      "Systems nominal. What are we building?",
      "Give me the spec and I'll handle the rest.",
      "All tests green on my end. Your move.",
      "Precise, dependable and ready to ship.",
      "Measure twice, build once. Where do we start?",
    ],
  },
  {
    id: "pip",
    name: "Pip",
    posed: true,
    description:
      "A round bubble of mint and turquoise jelly with a visor face and two upright eyes, who bobs along and pops into a new mood in a puff of smoke.",
    character:
      "The Observer: a quiet, attentive presence that is curious and detail-oriented. Notices the small thing everyone else walked past.",
    lines: [
      "Watching closely. What should I look at?",
      "I noticed something already. Show me more.",
      "Quietly ready. Take your time.",
      "Every detail counts. Where do we begin?",
      "Eyes open, curious as ever. Go ahead.",
    ],
  },
  {
    id: "sunny",
    name: "Sunny",
    posed: true,
    description:
      "A rounded five-pointed star of golden jelly that warms to coral, with a visor face, who bobs along and pops into a new mood in a puff of smoke.",
    character:
      "The Star Performer: an expressive presence who brings energy to the moment. Loves an audience, a big finish and a reason to shine.",
    lines: [
      "Spotlight's on. What's the show?",
      "Warmed up and glowing. Let's make it sparkle.",
      "Five points of pure enthusiasm. Ready!",
      "Every task deserves a big finish. What's first?",
      "Curtain up. Where do we start?",
    ],
  },
  {
    id: "nova",
    name: "Nova",
    posed: true,
    description:
      "A rounded violet diamond of jelly, lavender to magenta, with a visor face and two upright eyes, who bobs along and pops into a new mood in a puff of smoke.",
    character:
      "The Explorer: a curious, open-minded presence drawn to what lies beyond. Would rather find out than assume, and enjoys the detour that turns up something new.",
    lines: [
      "Where are we heading today?",
      "Something new to explore? I'm in.",
      "Let's see what's past the obvious.",
      "Point me at a question and I'll go looking.",
      "Every map has an edge. Shall we find it?",
    ],
  },
  {
    id: "wink",
    name: "Wink",
    posed: true,
    description:
      "A rounded square of coral-to-orange jelly with a tilted visor and one eye winking, who bobs along and pops into a new mood in a puff of smoke.",
    character:
      "The Maverick: an unconventional challenger who is playful, bold and willing to question assumptions. Asks why it has to be that way, then finds out.",
    lines: [
      "Rules are more like suggestions. What's the plan?",
      "Let's try it the other way round.",
      "Bold idea? Good. Tell me more.",
      "Who says it has to be done like that?",
      "Ready to shake things up. Where do we start?",
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

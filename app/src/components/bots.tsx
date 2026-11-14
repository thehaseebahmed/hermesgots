/**
 * Gots's bot characters. Each ships one pose per mood in public/bots/<id>/<mood>.png — its still is
 * the happy pose — and <Bot> (bot.tsx) draws the pose its mood names, changing between them in a poof.
 */

/** What a character can feel; each has its own pose and its own idle motion. */
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

/** The image a bot is drawn with: its mood's pose, the happy one standing for the bot at rest. */
export function botImage(bot: Pick<BotDefinition, "id">, mood: BotMood = DEFAULT_MOOD) {
  return `/bots/${bot.id}/${mood}.png`
}

type Lines = [string, string, string, string, string]

export interface BotDefinition {
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
    id: "crumb",
    name: "Crumb",
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

/**
 * Every id a device may still hold for a bot that has been redrawn, mapped onto the character that
 * took its place: the first set (v3) and the eight one-picture characters the posed ones replaced,
 * each by its shape. Read through `botIdOf`, never directly, so a chain can't stop half way.
 */
export const LEGACY_BOT_IDS: Record<string, string> = {
  bolt: "bubble",
  ember: "pixel",
  custard: "wink",
  nimbus: "pip",
  sprout: "nova",
  twinkle: "sunny",
  bubbles: "byte",
  mochi: "lovey",
  cubby: "bubble",
  tri: "pixel",
  penny: "wink",
  hex: "byte",
  stella: "sunny",
  orbi: "pip",
  gem: "nova",
  bloom: "lovey",
}

/** The character a stored id stands for today: a retired id is the one that replaced it. */
export function botIdOf(id: string): string {
  return LEGACY_BOT_IDS[id] ?? id
}

export const DEFAULT_BOT_ID = "bubble"

import { useLiveQuery } from "dexie-react-hooks"
import {
  BadgeCheckIcon,
  CompassIcon,
  GraduationCapIcon,
  LibraryBigIcon,
  LightbulbIcon,
  ScaleIcon,
  TargetIcon,
  type LucideIcon,
} from "lucide-react"

import { createStore } from "@/lib/store"
import { getSettings } from "@/lib/db"
import { randomId } from "@/lib/utils"

// Research is a UI mock so far: missions live in memory and their progress is simulated. Nothing
// reaches a bot yet.

/** Whether Research is on: experimental, so only behind the Developer switch. */
export function useResearchEnabled() {
  return useLiveQuery(async () => {
    const settings = await getSettings()
    return Boolean(settings.developer && settings.research)
  }, [])
}

export type MissionType =
  "learn" | "compare" | "verify" | "literature" | "prepare" | "investigate" | "brainstorm"

export const MISSION_TYPES: {
  id: MissionType
  name: string
  icon: LucideIcon
  example: string
  ready?: boolean
}[] = [
  {
    id: "learn",
    name: "Learn & understand",
    icon: GraduationCapIcon,
    example: "Explain how transformers work, starting from the basics",
    ready: true,
  },
  { id: "compare", name: "Compare & decide", icon: ScaleIcon, example: "Postgres or Cosmos DB?" },
  {
    id: "verify",
    name: "Verify a claim",
    icon: BadgeCheckIcon,
    example: "Does evidence support X?",
  },
  {
    id: "literature",
    name: "Literature review",
    icon: LibraryBigIcon,
    example: "What does research say about X?",
  },
  {
    id: "prepare",
    name: "Prepare for something",
    icon: TargetIcon,
    example: "Interview prep, senior engineer",
  },
  {
    id: "investigate",
    name: "Investigate & create",
    icon: CompassIcon,
    example: "Market report on local-first apps",
  },
  { id: "brainstorm", name: "Brainstorm", icon: LightbulbIcon, example: "10 novel feature ideas" },
]

export type OutputFormat = "guide" | "quiz" | "glossary"
export const FORMATS: { id: OutputFormat; name: string }[] = [
  { id: "guide", name: "Guide" },
  { id: "quiz", name: "Quiz" },
  { id: "glossary", name: "Glossary" },
]

export type Depth = "overview" | "deep"

export type SourceKind = "papers" | "docs" | "articles" | "videos" | "forums"
export const SOURCE_KINDS: { id: SourceKind; name: string }[] = [
  { id: "papers", name: "Papers" },
  { id: "docs", name: "Official docs" },
  { id: "articles", name: "Articles and blogs" },
  { id: "videos", name: "Videos and talks" },
  { id: "forums", name: "Forums" },
]

/** Brief → Scope Gate → research (reading, drafting, reviewing) → delivered. */
export type MissionStage = "brief" | "scope" | "reading" | "drafting" | "reviewing" | "delivered"

export interface Source {
  id: string
  title: string
  url: string
  kind: SourceKind
}

/** A ledger entry: what was claimed, where, and the passage that says so. */
export interface Claim {
  id: string
  text: string
  source: string
  snippet: string
  confidence: "supported" | "uncertain"
}

/** A run of text, with the claims behind it, or flagged when no claim backs it. */
export interface Span {
  text: string
  cites?: string[]
  flagged?: boolean
}

export interface Section {
  title: string
  paragraphs: Span[][]
}

export interface QuizQuestion {
  question: string
  choices: string[]
  answer: number
  cite: string
}

export interface GlossaryTerm {
  term: string
  definition: string
  cite: string
}

export interface Mission {
  id: string
  type: MissionType
  /** What the user typed. */
  input: string
  title: string
  goal: string
  format: OutputFormat
  audience: string
  depth: Depth
  outline: string[]
  sources: SourceKind[]
  stage: MissionStage
  createdAt: number
  /** Sources read so far, of `found`. */
  read: number
  found: number
  /** Sections of the first format written so far. */
  written: number
  /** Formats made from the ledger, in order, and the one being made. */
  formats: OutputFormat[]
  making?: OutputFormat
  /** Advances on its own, for a mission started here. */
  live?: boolean
}

// The one mission's worth of content every mock mission shows.

export const SOURCES: Source[] = [
  {
    id: "s1",
    title: "Attention Is All You Need",
    url: "https://arxiv.org/abs/1706.03762",
    kind: "papers",
  },
  {
    id: "s2",
    title: "The Illustrated Transformer",
    url: "https://jalammar.github.io/illustrated-transformer/",
    kind: "articles",
  },
  {
    id: "s3",
    title: "Layer Normalization",
    url: "https://arxiv.org/abs/1607.06450",
    kind: "papers",
  },
  {
    id: "s4",
    title: "Deep Residual Learning for Image Recognition",
    url: "https://arxiv.org/abs/1512.03385",
    kind: "papers",
  },
  {
    id: "s5",
    title: "BERT: Pre-training of Deep Bidirectional Transformers",
    url: "https://arxiv.org/abs/1810.04805",
    kind: "papers",
  },
]

export const CLAIMS: Claim[] = [
  {
    id: "c1",
    text: "The Transformer drops recurrence and convolutions and relies on attention alone.",
    source: "s1",
    snippet:
      "We propose a new simple network architecture, the Transformer, based solely on attention mechanisms, dispensing with recurrence and convolutions entirely.",
    confidence: "supported",
  },
  {
    id: "c2",
    text: "Each word is turned into a vector by an embedding before the first layer.",
    source: "s2",
    snippet:
      "As is the case in NLP applications in general, we begin by turning each input word into a vector using an embedding algorithm.",
    confidence: "supported",
  },
  {
    id: "c3",
    text: "Position is added to the embeddings, because nothing else tells the model the order.",
    source: "s1",
    snippet:
      "Since our model contains no recurrence and no convolution, in order for the model to make use of the order of the sequence, we must inject some information about the relative or absolute position of the tokens in the sequence.",
    confidence: "supported",
  },
  {
    id: "c4",
    text: "Attention scores are dot products of a query with every key, scaled by √dₖ and softmaxed.",
    source: "s1",
    snippet:
      "We compute the dot products of the query with all keys, divide each by √dk, and apply a softmax function to obtain the weights on the values.",
    confidence: "supported",
  },
  {
    id: "c5",
    text: "Several heads attend in parallel, each to a different representation subspace.",
    source: "s1",
    snippet:
      "Multi-head attention allows the model to jointly attend to information from different representation subspaces at different positions.",
    confidence: "supported",
  },
  {
    id: "c6",
    text: "Every sub-layer sits inside a residual connection followed by layer normalization.",
    source: "s1",
    snippet:
      "We employ a residual connection around each of the two sub-layers, followed by layer normalization.",
    confidence: "supported",
  },
  {
    id: "c7",
    text: "Residual connections make very deep networks easier to train.",
    source: "s4",
    snippet:
      "We present a residual learning framework to ease the training of networks that are substantially deeper than those used previously.",
    confidence: "supported",
  },
  {
    id: "c8",
    text: "Layer normalization normalizes over a layer's units, so it doesn't depend on the batch.",
    source: "s3",
    snippet:
      "We transpose batch normalization into layer normalization by computing the mean and variance used for normalization from all of the summed inputs to the neurons in a layer on a single training case.",
    confidence: "supported",
  },
  {
    id: "c9",
    text: "The decoder masks future positions, so a prediction only sees earlier outputs.",
    source: "s1",
    snippet:
      "This masking, combined with fact that the output embeddings are offset by one position, ensures that the predictions for position i can depend only on the known outputs at positions less than i.",
    confidence: "supported",
  },
  {
    id: "c10",
    text: "Encoder-only models like BERT read the whole sentence in both directions at once.",
    source: "s5",
    snippet:
      "BERT is designed to pre-train deep bidirectional representations from unlabeled text by jointly conditioning on both left and right context in all layers.",
    confidence: "supported",
  },
  {
    id: "c11",
    text: "The base model trained in 12 hours on eight P100 GPUs.",
    source: "s1",
    snippet: "We trained the base models for a total of 100,000 steps or 12 hours.",
    confidence: "uncertain",
  },
]

export const GUIDE: Section[] = [
  {
    title: "Why transformers exist",
    paragraphs: [
      [
        {
          text: "Before 2017, language models read a sentence one word at a time, carrying a memory forward. The Transformer threw that out: it looks at every word at once and lets each one decide which others matter.",
          cites: ["c1"],
        },
        {
          text: " That's why they took over almost every language task within a few years.",
          flagged: true,
        },
      ],
    ],
  },
  {
    title: "From words to vectors",
    paragraphs: [
      [
        {
          text: "The model can't read text, so each word (strictly, each token) becomes a list of numbers, its embedding.",
          cites: ["c2"],
        },
        {
          text: " Because attention looks at all the words at once, the order would be lost, so a positional signal is added to every embedding.",
          cites: ["c3"],
        },
      ],
    ],
  },
  {
    title: "Attention, step by step",
    paragraphs: [
      [
        {
          text: "Each word asks a question (its query) and offers a label (its key). Comparing one word's query with every key gives a score per word; scaled and passed through a softmax, the scores become weights for mixing the words' values.",
          cites: ["c4"],
        },
      ],
      [
        {
          text: "One set of weights can only capture one kind of relationship, so the model runs several attention heads side by side and joins their results.",
          cites: ["c5"],
        },
      ],
    ],
  },
  {
    title: "Stacking layers",
    paragraphs: [
      [
        {
          text: "A layer is attention followed by a small feed-forward network. Each of the two is wrapped in a shortcut that adds its input back to its output, then normalized.",
          cites: ["c6"],
        },
        {
          text: " The shortcuts are what let dozens of layers train at all,",
          cites: ["c7"],
        },
        {
          text: " and normalizing per layer keeps the numbers in range without depending on the batch.",
          cites: ["c8"],
        },
      ],
    ],
  },
  {
    title: "Encoders, decoders and what came next",
    paragraphs: [
      [
        {
          text: "The original model has an encoder that reads the input and a decoder that writes the output one token at a time, masked so it never peeks ahead.",
          cites: ["c9"],
        },
        {
          text: " Later models kept only one half: BERT is an encoder that reads in both directions,",
          cites: ["c10"],
        },
        {
          text: " while GPT-style models are decoders that predict the next word.",
          flagged: true,
        },
      ],
    ],
  },
]

export const QUIZ: QuizQuestion[] = [
  {
    question: "What did the Transformer remove that earlier language models relied on?",
    choices: ["Embeddings", "Recurrence", "Softmax", "Training data"],
    answer: 1,
    cite: "c1",
  },
  {
    question: "Why is a positional signal added to each embedding?",
    choices: [
      "To make the vectors shorter",
      "Attention alone doesn't know word order",
      "To mark the end of a sentence",
      "It speeds up training",
    ],
    answer: 1,
    cite: "c3",
  },
  {
    question: "What are attention scores divided by before the softmax?",
    choices: ["The batch size", "The number of heads", "√dₖ", "The sentence length"],
    answer: 2,
    cite: "c4",
  },
  {
    question: "Why does the decoder mask future positions?",
    choices: [
      "To save memory",
      "So a prediction only sees earlier outputs",
      "To handle long sentences",
      "Because the encoder can't",
    ],
    answer: 1,
    cite: "c9",
  },
]

export const GLOSSARY: GlossaryTerm[] = [
  {
    term: "Attention",
    definition: "Weighing every other word by how much it matters to this one.",
    cite: "c4",
  },
  {
    term: "Embedding",
    definition: "The list of numbers a word becomes before the model reads it.",
    cite: "c2",
  },
  {
    term: "Head",
    definition: "One of several attention calculations run side by side.",
    cite: "c5",
  },
  {
    term: "Layer normalization",
    definition: "Rescaling a layer's outputs so they stay in a steady range.",
    cite: "c8",
  },
  {
    term: "Positional encoding",
    definition: "The signal added to embeddings so the model knows word order.",
    cite: "c3",
  },
  {
    term: "Residual connection",
    definition: "A shortcut that adds a sub-layer's input back to its output.",
    cite: "c6",
  },
]

const OUTLINE = [
  "Why transformers replaced recurrent networks",
  "Tokens, embeddings and positional encoding",
  "Self-attention: queries, keys and values",
  "Multi-head attention and feed-forward layers",
  "Encoder, decoder and the models built on them",
]

const HOUR = 3_600_000
const now = Date.now()

const seed: Mission[] = [
  {
    id: "transformers",
    type: "learn",
    input: "Explain how transformers work, starting from the basics",
    title: "How transformers work",
    goal: "Understand how a transformer turns text into predictions, from embeddings to attention to stacked layers.",
    format: "guide",
    audience: "A developer new to machine learning",
    depth: "overview",
    outline: OUTLINE,
    sources: ["papers", "docs", "articles"],
    stage: "delivered",
    createdAt: now - 26 * HOUR,
    read: 14,
    found: 14,
    written: GUIDE.length,
    formats: ["guide", "quiz"],
  },
  {
    id: "llm-attention",
    type: "learn",
    input: "Walk me through the transformer architecture for a product manager",
    title: "Transformers for product managers",
    goal: "Understand the transformer architecture well enough to talk about model choices, without the maths.",
    format: "guide",
    audience: "A product manager",
    depth: "overview",
    outline: OUTLINE,
    sources: ["docs", "articles"],
    stage: "drafting",
    createdAt: now - 0.2 * HOUR,
    read: 11,
    found: 11,
    written: 1,
    formats: [],
  },
  {
    id: "crdts",
    type: "learn",
    input: "How do CRDTs work and why do local-first apps use them?",
    title: "CRDTs and local-first apps",
    goal: "Understand what CRDTs are, how they merge edits without a server, and why local-first apps rely on them.",
    format: "guide",
    audience: "A web developer",
    depth: "deep",
    outline: [
      "The problem: editing the same data on two offline devices",
      "State-based and operation-based CRDTs",
      "Common types: counters, registers, sets and sequences",
      "How local-first apps like Automerge and Yjs use them",
      "Costs: metadata growth and garbage collection",
    ],
    sources: ["papers", "docs", "articles"],
    stage: "scope",
    createdAt: now - 1.5 * HOUR,
    read: 0,
    found: 0,
    written: 0,
    formats: [],
  },
  {
    id: "kidney",
    type: "learn",
    input: "what do kidneys actually do",
    title: "What kidneys do",
    goal: "Learn what the kidneys do in the body: filtering blood, balancing fluids and salts, and the hormones they make.",
    format: "glossary",
    audience: "Someone with no biology background",
    depth: "overview",
    outline: [],
    sources: ["articles", "docs"],
    stage: "brief",
    createdAt: now - 3 * HOUR,
    read: 0,
    found: 0,
    written: 0,
    formats: [],
  },
  {
    id: "byzantine",
    type: "learn",
    input: "Explain the Byzantine generals problem",
    title: "The Byzantine generals problem",
    goal: "Understand the Byzantine generals problem and how consensus protocols tolerate faulty nodes.",
    format: "quiz",
    audience: "A software engineer",
    depth: "overview",
    outline: [],
    sources: ["papers", "articles"],
    stage: "delivered",
    createdAt: now - 5 * 24 * HOUR,
    read: 9,
    found: 9,
    written: 4,
    formats: ["quiz", "guide", "glossary"],
  },
]

const missions = createStore(seed)

export function useMissions() {
  return missions.use()
}

export function useMission(id: string) {
  return useMissions().find((m) => m.id === id)
}

export function updateMission(id: string, patch: Partial<Mission>) {
  missions.set(missions.get().map((m) => (m.id === id ? { ...m, ...patch } : m)))
}

/** What the mock "infers" from a typed topic. */
export function createMission(input: string): Mission {
  const text = input.trim().replace(/[.?!]+$/, "")
  const topic = text.replace(
    /^(explain|teach me|tell me about|how does|how do|what is|what are)\s+/i,
    "",
  )
  const mission: Mission = {
    id: randomId(),
    type: "learn",
    input,
    title: topic.charAt(0).toUpperCase() + topic.slice(1),
    goal: `Understand ${topic}, starting from the basics and building up to how it's used in practice.`,
    format: "guide",
    audience: "A curious beginner",
    depth: "overview",
    outline: [],
    sources: ["papers", "docs", "articles"],
    stage: "brief",
    createdAt: Date.now(),
    read: 0,
    found: 0,
    written: 0,
    formats: [],
  }
  missions.set([mission, ...missions.get()])
  return mission
}

/** The mock's proposed outline for a brief: the transformers one, or one shaped by the goal. */
export function proposeOutline(mission: Mission) {
  if (mission.outline.length) return mission.outline
  if (/transformer/i.test(mission.input)) return OUTLINE
  return [
    `What ${mission.title.toLowerCase()} is, in plain words`,
    "The key ideas, one at a time",
    "How the pieces fit together",
    "Common misconceptions",
    "Where to go next",
  ]
}

export const sourceOf = (claim: Claim) => SOURCES.find((s) => s.id === claim.source)!
export const claimNumber = (id: string) => CLAIMS.findIndex((c) => c.id === id) + 1
export const hostOf = (url: string) => new URL(url).hostname.replace(/^www\./, "")

export const RESEARCH_STAGES: { id: MissionStage; name: string }[] = [
  { id: "reading", name: "Reading sources" },
  { id: "drafting", name: "Drafting" },
  { id: "reviewing", name: "Reviewing" },
]

/** Plays live missions forward: reading sources, then a section at a time, then the review. */
const STEP_MS = 1800
let timer: number | undefined

function tick() {
  const live = missions.get().filter((m) => m.live)
  if (!live.length) {
    window.clearInterval(timer)
    timer = undefined
    return
  }
  for (const m of live) {
    if (m.making) {
      updateMission(m.id, { formats: [...m.formats, m.making], making: undefined, live: false })
    } else if (m.stage === "reading") {
      const read = Math.min(m.found, m.read + 3)
      updateMission(m.id, { read, stage: read === m.found ? "drafting" : "reading" })
    } else if (m.stage === "drafting") {
      const written = m.written + 1
      updateMission(m.id, { written, stage: written >= GUIDE.length ? "reviewing" : "drafting" })
    } else if (m.stage === "reviewing") {
      updateMission(m.id, { stage: "delivered", formats: [m.format], live: false })
    }
  }
}

const play = () => {
  timer ??= window.setInterval(tick, STEP_MS)
}

export function startMission(id: string) {
  updateMission(id, { stage: "reading", read: 0, found: 14, written: 0, live: true })
  play()
}

/** Another format from the same ledger: no new reading, only writing. */
export function makeFormat(id: string, format: OutputFormat) {
  updateMission(id, { making: format, live: true })
  play()
}

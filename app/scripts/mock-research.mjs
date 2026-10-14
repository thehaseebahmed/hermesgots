// The Memento plugin's research missions (research.py), for the mock Hermes server. A mission reads
// its question back after a moment, proposes an outline, then "researches": a claim from the
// transformers ledger below every 0.7s, a guide section every 1.5s, a short review, delivered.
// Another format takes 3s. MOCK_RESEARCH_FAIL=1 fails the reading once, to show Try again.

const SOURCES = [
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

const CLAIMS = [
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

const GUIDE = [
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

const QUIZ = [
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

const GLOSSARY = [
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


const SOURCE_KINDS = ["papers", "docs", "articles", "videos", "forums"]
const FAIL_ONCE = process.env.MOCK_RESEARCH_FAIL === "1"
const HOUR = 3_600_000
const missions = new Map()
let failed = false

function mission(fields) {
  const now = Date.now()
  return {
    type: "learn",
    goal: "",
    format: "guide",
    audience: "",
    depth: "overview",
    outline: [],
    source_kinds: ["papers", "docs", "articles"],
    stage: "brief",
    busy: null,
    error: null,
    formats: [],
    making: null,
    written: 0,
    created_at: now,
    updated_at: now,
    ledger: { sources: [], claims: [] },
    outputs: {},
    ...fields,
  }
}

function delivered(id, fields, formats) {
  const outputs = {}
  if (formats.includes("guide")) outputs.guide = { sections: GUIDE }
  if (formats.includes("quiz")) outputs.quiz = { questions: QUIZ }
  if (formats.includes("glossary")) outputs.glossary = { terms: GLOSSARY }
  missions.set(
    id,
    mission({
      id,
      ...fields,
      stage: "delivered",
      formats,
      written: GUIDE.length,
      ledger: { sources: SOURCES, claims: CLAIMS },
      outputs,
    }),
  )
}

delivered(
  "transformers",
  {
    input: "Explain how transformers work, starting from the basics",
    title: "How transformers work",
    goal: "Understand how a transformer turns text into predictions, from embeddings to attention to stacked layers.",
    audience: "A developer new to machine learning",
    outline: OUTLINE,
    created_at: Date.now() - 26 * HOUR,
  },
  ["guide", "quiz"],
)
missions.set(
  "crdts",
  mission({
    id: "crdts",
    input: "How do CRDTs work and why do local-first apps use them?",
    title: "CRDTs and local-first apps",
    goal: "Understand what CRDTs are, how they merge edits without a server, and why local-first apps rely on them.",
    audience: "A web developer",
    depth: "deep",
    stage: "scope",
    outline: [
      "The problem: editing the same data on two offline devices",
      "State-based and operation-based CRDTs",
      "Common types: counters, registers, sets and sequences",
      "How local-first apps like Automerge and Yjs use them",
      "Costs: metadata growth and garbage collection",
    ],
    created_at: Date.now() - 1.5 * HOUR,
  }),
)
missions.set(
  "kidney",
  mission({
    id: "kidney",
    input: "what do kidneys actually do",
    title: "What kidneys do",
    goal: "Learn what the kidneys do in the body: filtering blood, balancing fluids and salts, and the hormones they make.",
    format: "glossary",
    audience: "Someone with no biology background",
    source_kinds: ["articles", "docs"],
    created_at: Date.now() - 3 * HOUR,
  }),
)

function summary(m) {
  const { ledger, outputs: _outputs, ...rest } = m
  return { ...rest, found: ledger.sources.length, claims: ledger.claims.length }
}

function full(m) {
  return { ...summary(m), ledger: m.ledger, outputs: m.outputs }
}

function change(m, fields, note) {
  Object.assign(m, fields, { updated_at: Date.now() })
  note(m.id)
}

function later(ms, fn) {
  setTimeout(fn, ms)
}

function readBrief(m, note) {
  later(1500, () => {
    if (!missions.has(m.id)) return
    const text = m.input.trim().replace(/[.?!]+$/, "")
    const topic = text.replace(/^(explain|teach me|tell me about|how does|how do|what is|what are)\s+/i, "")
    change(
      m,
      {
        busy: null,
        title: topic.charAt(0).toUpperCase() + topic.slice(1),
        goal: `Understand ${topic}, starting from the basics and building up to how it's used in practice.`,
        audience: "A curious beginner",
      },
      note,
    )
  })
}

function proposeOutline(m, note) {
  later(1500, () => {
    if (!missions.has(m.id)) return
    const outline = /transformer/i.test(m.input)
      ? OUTLINE
      : [
          `What ${m.title.toLowerCase()} is, in plain words`,
          "The key ideas, one at a time",
          "How the pieces fit together",
          "Common misconceptions",
          "Where to go next",
        ]
    change(m, { busy: null, outline }, note)
  })
}

function research(m, note) {
  const step = () => {
    if (!missions.has(m.id) || m.stage !== "reading") return
    const claims = m.ledger.claims
    if (FAIL_ONCE && !failed && claims.length === 4) {
      failed = true
      return change(m, { error: "The researcher stopped before recording enough sources." }, note)
    }
    if (claims.length < CLAIMS.length) {
      const claim = CLAIMS[claims.length]
      if (!m.ledger.sources.some((s) => s.id === claim.source))
        m.ledger.sources.push(SOURCES.find((s) => s.id === claim.source))
      claims.push(claim)
      change(m, {}, note)
      return later(700, step)
    }
    change(m, { stage: "drafting", written: 0 }, note)
    later(1500, draft)
  }
  const draft = () => {
    if (!missions.has(m.id)) return
    if (m.format !== "guide") {
      m.outputs[m.format] = m.format === "quiz" ? { questions: QUIZ } : { terms: GLOSSARY }
      change(m, { written: 1, stage: "reviewing" }, note)
      return later(1000, finish)
    }
    const sections = (m.outputs.guide ??= { sections: [] }).sections
    sections.push({ ...GUIDE[sections.length % GUIDE.length], title: m.outline[sections.length] ?? GUIDE[sections.length % GUIDE.length].title })
    change(m, { written: sections.length }, note)
    if (sections.length < m.outline.length) return later(1500, draft)
    change(m, { stage: "reviewing" }, note)
    later(1000, finish)
  }
  const finish = () => {
    if (!missions.has(m.id)) return
    change(m, { stage: "delivered", formats: [m.format] }, note)
  }
  later(700, step)
}

function makeFormat(m, note) {
  later(3000, () => {
    if (!missions.has(m.id)) return
    const format = m.making
    m.outputs[format] =
      format === "quiz" ? { questions: QUIZ } : format === "glossary" ? { terms: GLOSSARY } : { sections: GUIDE }
    change(m, { making: null, formats: [...m.formats, format] }, note)
  })
}

/** Answers a research route, or returns false for any other path. */
export async function handleResearch(req, res, path, { json, readBody, noteEvent }) {
  if (!path.startsWith("/api/plugins/memento/research")) return false
  const note = (id) => noteEvent("research", id)
  const answer = (m) => json(res, 200, { object: "memento.research.mission", mission: full(m) })
  const fail = (status, message) => json(res, status, { error: { message } })
  if (path === "/api/plugins/memento/research") {
    if (req.method === "GET") {
      const list = [...missions.values()].sort((a, b) => b.created_at - a.created_at).map(summary)
      json(res, 200, { object: "memento.research", missions: list, unavailable: null })
      return true
    }
    const { input, type } = await readBody(req)
    if (typeof input !== "string" || !input.trim()) return fail(400, "The question is required."), true
    if (type && type !== "learn") return fail(400, "Only Learn & understand missions can be started so far."), true
    const m = mission({ id: `r_${Math.random().toString(16).slice(2, 18)}`, input, title: input, busy: "brief" })
    missions.set(m.id, m)
    note(m.id)
    readBrief(m, note)
    json(res, 202, { object: "memento.research.mission", mission: full(m) })
    return true
  }
  const match = /^\/api\/plugins\/memento\/research\/([^/]+)(?:\/(\w+))?$/.exec(path)
  const m = match && missions.get(decodeURIComponent(match[1]))
  if (!m) return fail(404, "No such mission."), true
  const action = match[2]
  if (!action) return answer(m), true
  const body = await readBody(req)
  const moved = (stages) => !stages.includes(m.stage) || m.busy
  switch (action) {
    case "brief":
      if (moved(["brief"])) return fail(409, "The mission has moved on; reload it."), true
      change(m, { goal: body.goal, audience: body.audience, format: body.format, depth: body.depth, stage: "scope", busy: "outline", outline: [], error: null }, note)
      proposeOutline(m, note)
      break
    case "edit":
      if (moved(["scope"])) return fail(409, "The mission has moved on; reload it."), true
      change(m, { stage: "brief", error: null }, note)
      break
    case "start": {
      if (moved(["scope"])) return fail(409, "The mission has moved on; reload it."), true
      const outline = (body.outline ?? []).filter((p) => typeof p === "string" && p.trim())
      const kinds = body.source_kinds ?? []
      if (!outline.length) return fail(400, "The outline needs a point."), true
      if (!kinds.length || kinds.some((k) => !SOURCE_KINDS.includes(k))) return fail(400, "Pick the kinds of source."), true
      m.ledger = { sources: [], claims: [] }
      m.outputs = {}
      change(m, { outline, source_kinds: kinds, stage: "reading", written: 0, formats: [], error: null }, note)
      research(m, note)
      break
    }
    case "formats":
      if (moved(["delivered"]) || m.making || m.formats.includes(body.format))
        return fail(409, "That format is already made or on its way."), true
      change(m, { making: body.format, error: null }, note)
      makeFormat(m, note)
      break
    case "retry":
      if (!m.error) return fail(409, "Nothing failed."), true
      change(m, { error: null }, note)
      if (m.stage === "reading") research(m, note)
      break
    case "remove":
      missions.delete(m.id)
      note(m.id)
      json(res, 200, { object: "memento.research.removed", removed: true })
      return true
    default:
      return fail(404, "Not found"), true
  }
  answer(m)
  return true
}

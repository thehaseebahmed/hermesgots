// The Gots plugin's research missions (research.py), for the mock Hermes server. A mission reads
// its question back after a moment, proposes an outline, then "researches": a claim from the
// transformers ledger below every 0.7s, a guide section every 1.5s, a short review, delivered.
// Another format takes 3s. A follow-up reads two more claims, works its questions into the outline
// and writes the whole guide again; a rewrite with another model writes it again from the ledger.
// Each delivery is kept as a revision. MOCK_RESEARCH_FAIL=1 fails the reading once, to show Try
// again; MOCK_RESEARCH_WRITERS=off refuses another model.

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

// What a follow-up round finds, whatever was asked.
const MORE_CLAIMS = [
  {
    id: "c12",
    text: "The model was trained with the Adam optimizer and a learning rate that warms up, then decays.",
    source: "s1",
    snippet:
      "We used the Adam optimizer with β1 = 0.9, β2 = 0.98 and ϵ = 10−9. We varied the learning rate over the course of training.",
    confidence: "supported",
  },
  {
    id: "c13",
    text: "BERT is pre-trained by predicting masked words from the words around them.",
    source: "s5",
    snippet:
      "The masked language model randomly masks some of the tokens from the input, and the objective is to predict the original vocabulary id of the masked word based only on its context.",
    confidence: "supported",
  },
]

const SUGGESTIONS = [
  "How is a transformer trained?",
  "Why do transformers need so much data?",
  "What limits how long the input can be?",
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


// A comparison: three runtimes on three criteria, with a claim or two for each cell, the advocates'
// cases and the judge's scores. Node.js wins; Deno is ruled out on one criterion.
const COMPARE_SOURCES = [
  { id: "s1", title: "Bun documentation: runtime", url: "https://bun.sh/docs/runtime", kind: "docs" },
  { id: "s2", title: "Node.js releases", url: "https://nodejs.org/en/about/previous-releases", kind: "docs" },
  { id: "s3", title: "Deno manual: compatibility", url: "https://docs.deno.com/runtime/fundamentals/node/", kind: "docs" },
]

const COMPARE_CLAIMS = [
  { id: "c1", option: "o1", criterion: "k1", source: "s1", confidence: "supported", text: "Bun starts and installs packages much faster than Node.js.", snippet: "Bun starts up to 4x faster than Node.js and installs packages up to 25x faster than npm." },
  { id: "c2", option: "o2", criterion: "k1", source: "s2", confidence: "supported", text: "Node.js ships V8 and has no startup-time advantage over its rivals.", snippet: "Node.js is built on the V8 JavaScript engine and runs a single-threaded event loop." },
  { id: "c3", option: "o3", criterion: "k1", source: "s3", confidence: "uncertain", text: "Deno's startup is quick for small programs, but type checking adds time.", snippet: "Deno checks types by default, which adds a step before a program runs." },
  { id: "c4", option: "o2", criterion: "k2", source: "s2", confidence: "supported", text: "Node.js has the largest package ecosystem and every tool supports it.", snippet: "The npm registry hosts more than two million packages, and Node.js is the runtime they target first." },
  { id: "c5", option: "o1", criterion: "k2", source: "s1", confidence: "supported", text: "Bun aims to run most Node.js packages unchanged, but not all of them.", snippet: "Bun implements the majority of Node.js APIs, and some modules are not yet fully supported." },
  { id: "c6", option: "o3", criterion: "k2", source: "s3", confidence: "supported", text: "Deno can run npm packages, but some native add-ons don't work.", snippet: "Deno supports npm packages through npm: specifiers, with limits on native add-ons." },
  { id: "c7", option: "o2", criterion: "k3", source: "s2", confidence: "supported", text: "Node.js publishes long-term support lines that get fixes for years.", snippet: "Even-numbered releases become Long Term Support and are maintained for 30 months." },
  { id: "c8", option: "o1", criterion: "k3", source: "s1", confidence: "supported", text: "Bun is younger and its releases change behavior more often.", snippet: "Bun is still under active development and some APIs may change between minor releases." },
]

const COMPARE_OPTIONS = [
  { id: "o1", name: "Bun" },
  { id: "o2", name: "Node.js" },
  { id: "o3", name: "Deno" },
]
const COMPARE_CRITERIA = [
  { id: "k1", name: "Speed", weight: 4 },
  { id: "k2", name: "Ecosystem", weight: 5 },
  { id: "k3", name: "Stability", weight: 3 },
]

const para = (...spans) => [spans]
const CASES = {
  o1: para({ text: "Bun is the fastest of the three to start and to install packages.", cites: ["c1"] }, { text: " It runs most Node.js code unchanged, though not all.", cites: ["c5"] }),
  o2: para({ text: "Node.js has the largest ecosystem, and every tool targets it first.", cites: ["c4"] }, { text: " Its long-term support lines are maintained for years.", cites: ["c7"] }),
  o3: para({ text: "Deno runs npm packages, and small programs start quickly.", cites: ["c6", "c3"] }),
}
const REBUTTALS = {
  o1: para({ text: "Node.js's ecosystem lead is real, but Bun runs most of it unchanged.", cites: ["c4", "c5"] }),
  o2: para({ text: "Bun starts faster, but it is younger and its behavior changes more often.", cites: ["c1", "c8"] }),
  o3: para({ text: "Neither rival is as strict about types by default.", flagged: true }),
}
const SCORES = {
  o1: {
    k1: { score: 9, reason: "Starts and installs far faster than the others.", claims: ["c1"], flagged: false },
    k2: { score: 6, reason: "Runs most but not all Node.js packages.", claims: ["c5"], flagged: false },
    k3: { score: 4, reason: "Younger, with APIs that still move.", claims: ["c8"], flagged: false },
  },
  o2: {
    k1: { score: 6, reason: "No startup advantage.", claims: ["c2"], flagged: false },
    k2: { score: 10, reason: "The biggest ecosystem by a long way.", claims: ["c4"], flagged: false },
    k3: { score: 9, reason: "Long-term support lines.", claims: ["c7"], flagged: false },
  },
  o3: {
    k1: { score: 6, reason: "Quick for small programs; type checking adds time.", claims: ["c3"], flagged: false },
    k2: { score: 3, reason: "No claim shows it covers native add-ons.", claims: [], flagged: true },
    k3: { score: 6, reason: "", claims: [], flagged: true },
  },
}
const VERDICT = para(
  { text: "Node.js leads: it has the largest ecosystem and the most stable releases.", cites: ["c4", "c7"] },
  { text: " Bun's speed is real but it weighs less than compatibility here.", cites: ["c1"] },
)
const FLIP = para({ text: "Packages Bun fully supports would close the gap.", cites: ["c5"] })

/** The ranking as research.py's `decide` works it out: weighted scores out of 100. */
function decide(m) {
  const memo = m.outputs.memo
  if (!memo?.scores) return { ranking: [], leader: null, margin: null, close: false }
  const ruled = new Set((memo.ruled_out ?? []).map((r) => r.option))
  const weight = m.criteria.reduce((sum, k) => sum + k.weight, 0)
  const rows = m.options.map((o) => {
    const cells = memo.scores[o.id] ?? {}
    const got = m.criteria.reduce((sum, k) => sum + (cells[k.id]?.score ?? 0) * k.weight, 0)
    const thin = m.criteria.filter((k) => cells[k.id]?.flagged || cells[k.id]?.score == null).map((k) => k.id)
    return { option: o.id, total: Math.round((got / (weight * 10)) * 100), ruled_out: ruled.has(o.id), thin }
  })
  const ranking = rows.sort((a, b) => a.ruled_out - b.ruled_out || b.total - a.total)
  const eligible = ranking.filter((r) => !r.ruled_out)
  const margin = eligible.length > 1 ? eligible[0].total - eligible[1].total : null
  return { ranking, leader: eligible[0]?.option ?? null, margin, close: margin !== null && margin <= 5 }
}

const SOURCE_KINDS = ["papers", "docs", "articles", "videos", "forums"]
const FAIL_ONCE = process.env.MOCK_RESEARCH_FAIL === "1"
const WRITERS = process.env.MOCK_RESEARCH_WRITERS !== "off"
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
    followups: [],
    suggestions: [],
    revisions: [],
    pending: null,
    writer: null,
    researcher: { provider: "anthropic", model: "claude-opus-5-5" },
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
      suggestions: SUGGESTIONS,
      ledger: { sources: SOURCES, claims: [...CLAIMS] },
      outputs,
    }),
  )
  const m = missions.get(id)
  revise(m, "first", {}, m.created_at + 0.4 * HOUR)
}

/** Keeps what the mission delivers now as its next revision. */
function revise(m, reason, detail = {}, at = Date.now()) {
  m.revisions.push({
    number: m.revisions.length + 1,
    reason,
    ...detail,
    claims: m.ledger.claims.length,
    at,
    outline: [...m.outline],
    outputs: structuredClone(m.outputs),
  })
}

/** A guide section for an outline point: the canned one it matches, or the follow-up's answer. */
function section(point, index) {
  const known = OUTLINE.indexOf(point)
  if (known >= 0) return GUIDE[known]
  if (/learn|train|mask/i.test(point))
    return {
      title: point,
      paragraphs: [
        [
          {
            text: "Training adjusts the weights with the Adam optimizer, with a learning rate that warms up and then decays.",
            cites: ["c12"],
          },
          {
            text: " Models like BERT first learn by filling in masked words from the words around them.",
            cites: ["c13"],
          },
        ],
      ],
    }
  return { ...GUIDE[index % GUIDE.length], title: point }
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
  const { ledger, outputs: _outputs, revisions: _revisions, ...rest } = m
  return { ...rest, found: ledger.sources.length, claims: ledger.claims.length }
}

function full(m) {
  const found = { ...summary(m), ledger: m.ledger, outputs: m.outputs, revisions: m.revisions }
  return m.type === "compare" ? { ...found, decision: decide(m) } : found
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

function readComparison(m, note) {
  later(1500, () => {
    if (!missions.has(m.id)) return
    change(
      m,
      {
        busy: null,
        title: "Bun, Node.js or Deno",
        goal: "Decide which JavaScript runtime to build a new backend on.",
        audience: "A developer starting a backend",
        options: COMPARE_OPTIONS,
        criteria: COMPARE_CRITERIA,
      },
      note,
    )
  })
}

/** A comparison's reading: its claims one at a time, then the memo built step by step. */
function compare(m, note) {
  const step = () => {
    if (!missions.has(m.id) || m.stage !== "reading") return
    const claims = m.ledger.claims
    if (claims.length < COMPARE_CLAIMS.length) {
      const { option, criterion, ...claim } = COMPARE_CLAIMS[claims.length]
      if (!m.ledger.sources.some((s) => s.id === claim.source))
        m.ledger.sources.push(COMPARE_SOURCES.find((s) => s.id === claim.source))
      claims.push({ ...claim, option, criterion })
      change(m, {}, note)
      return later(400, step)
    }
    change(m, { stage: "drafting", written: 0 }, note)
    later(800, () => memo(m, note))
  }
  later(400, step)
}

function memo(m, note) {
  const options = m.options.map((o) => ({ id: o.id, name: o.name, case: [], rebuttal: [] }))
  const save = (extra = {}) => {
    m.outputs.memo = { options: structuredClone(options), judged_by: m.judge, ...extra }
    change(m, { written: m.written + 1 }, note)
  }
  const steps = [
    ...options.map((o) => () => ((o.case = CASES[o.id]), save())),
    ...options.map((o) => () => ((o.rebuttal = REBUTTALS[o.id]), save())),
    () =>
      save({
        scores: SCORES,
        ruled_out: [{ option: "o3", criterion: "k2", claim: "c6" }],
        verdict: VERDICT,
        flip: FLIP,
      }),
  ]
  const next = () => {
    if (!missions.has(m.id)) return
    const run = steps.shift()
    if (run) return run(), later(700, next)
    change(m, { stage: "reviewing" }, note)
    later(600, () => {
      if (!missions.has(m.id)) return
      m.formats = ["memo"]
      revise(m, "first")
      change(m, { stage: "delivered", formats: ["memo"], pending: null }, note)
    })
  }
  next()
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
  const round = m.pending?.reason === "followup"
  const wanted = round ? [...CLAIMS, ...MORE_CLAIMS] : CLAIMS
  const step = () => {
    if (!missions.has(m.id) || m.stage !== "reading") return
    const claims = m.ledger.claims
    if (FAIL_ONCE && !failed && claims.length === 4) {
      failed = true
      return change(m, { error: "The researcher stopped before recording enough sources." }, note)
    }
    if (claims.length < wanted.length) {
      const claim = wanted[claims.length]
      if (!m.ledger.sources.some((s) => s.id === claim.source))
        m.ledger.sources.push(SOURCES.find((s) => s.id === claim.source))
      claims.push(claim)
      change(m, {}, note)
      return later(700, step)
    }
    change(m, round ? { stage: "drafting" } : { stage: "drafting", written: 0 }, note)
    write(m, note)
  }
  later(700, step)
}

/** Drafting, a section at a time; a rewrite starts the guide again, a follow-up's planned anew. */
function write(m, note) {
  const draft = () => {
    if (!missions.has(m.id)) return
    if (m.pending && !m.pending.planned) {
      let outline = m.outline
      if (m.pending.reason === "followup") {
        // Each question goes where it belongs: here, after the second point.
        outline = [...m.outline.slice(0, 2), ...m.pending.questions, ...m.outline.slice(2)].slice(0, 12)
      }
      delete m.outputs[m.format]
      change(m, { outline, written: 0, pending: { ...m.pending, planned: true } }, note)
    }
    if (m.format !== "guide") {
      m.outputs[m.format] = m.format === "quiz" ? { questions: QUIZ } : { terms: GLOSSARY }
      change(m, { written: 1, stage: "reviewing" }, note)
      return later(1000, finish)
    }
    const sections = (m.outputs.guide ??= { sections: [] }).sections
    const index = sections.length
    sections.push(section(m.outline[index], index))
    change(m, { written: sections.length }, note)
    if (sections.length < m.outline.length) return later(1500, draft)
    change(m, { stage: "reviewing" }, note)
    later(1000, finish)
  }
  const finish = () => {
    if (!missions.has(m.id)) return
    const formats = [m.format, ...m.formats.filter((f) => f !== m.format)]
    const { pending } = m
    m.formats = formats
    if (pending)
      revise(
        m,
        pending.reason,
        pending.reason === "followup" ? { questions: pending.questions } : { model: pending.model },
      )
    else if (!m.revisions.length) revise(m, "first")
    change(m, { stage: "delivered", pending: null, suggestions: pending ? [] : SUGGESTIONS }, note)
  }
  later(1500, draft)
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
    if (type && !["learn", "compare"].includes(type))
      return fail(400, "Only Learn & understand and Compare & decide missions can be started so far."), true
    const m = mission({
      id: `r_${Math.random().toString(16).slice(2, 18)}`,
      input,
      title: input,
      busy: "brief",
      ...(type === "compare" ? { type, format: "memo" } : {}),
    })
    missions.set(m.id, m)
    note(m.id)
    if (type === "compare") readComparison(m, note)
    else readBrief(m, note)
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
      if (m.type === "compare") {
        const names = [...new Set((body.options ?? []).map((o) => (typeof o === "string" ? o : o?.name)).filter((o) => typeof o === "string" && o.trim()))]
        const criteria = (body.criteria ?? []).filter((k) => typeof k?.name === "string" && k.name.trim())
        if (names.length < 2 || names.length > 5) return fail(400, "Compare 2 to 5 options."), true
        if (criteria.length < 2 || criteria.length > 6) return fail(400, "Judge on 2 to 6 criteria."), true
        if (criteria.some((k) => !Number.isInteger(k.weight) || k.weight < 1 || k.weight > 5))
          return fail(400, "A criterion's weight is a whole number from 1 to 5."), true
        change(
          m,
          {
            goal: body.goal,
            audience: body.audience,
            depth: body.depth,
            options: names.map((name, i) => ({ id: `o${i + 1}`, name })),
            criteria: criteria.map((k, i) => ({ id: `k${i + 1}`, name: k.name, weight: k.weight })),
            stage: "scope",
            outline: criteria.map((k) => k.name),
            error: null,
          },
          note,
        )
        break
      }
      change(m, { goal: body.goal, audience: body.audience, format: body.format, depth: body.depth, stage: "scope", busy: "outline", outline: [], error: null }, note)
      proposeOutline(m, note)
      break
    case "edit":
      if (moved(["scope"])) return fail(409, "The mission has moved on; reload it."), true
      change(m, { stage: "brief", error: null }, note)
      break
    case "start": {
      if (moved(["scope"])) return fail(409, "The mission has moved on; reload it."), true
      if (m.type === "compare") {
        const kinds = body.source_kinds ?? []
        if (!kinds.length || kinds.some((k) => !SOURCE_KINDS.includes(k))) return fail(400, "Pick the kinds of source."), true
        const judge = body.judge?.model ? { provider: body.judge.provider ?? "", model: body.judge.model } : null
        if (judge && !WRITERS)
          return fail(403, "This host doesn't let Gots pick the model. Allow it with `hermes plugins enable memento`."), true
        m.ledger = { sources: [], claims: [] }
        m.outputs = {}
        change(m, { source_kinds: kinds, judge, stage: "reading", written: 0, formats: [], error: null }, note)
        compare(m, note)
        break
      }
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
      if (m.type === "compare") return fail(400, "A comparison has one format, the memo."), true
      if (moved(["delivered"]) || m.making || m.formats.includes(body.format))
        return fail(409, "That format is already made or on its way."), true
      change(m, { making: body.format, error: null }, note)
      makeFormat(m, note)
      break
    case "followup": {
      if (m.type === "compare") return fail(400, "Questions can only be added to a Learn & understand mission so far."), true
      if (moved(["delivered"]) || m.making) return fail(409, "The mission has moved on; reload it."), true
      const covered = new Set(m.outline.map((p) => p.toLowerCase()))
      const questions = [...new Set((body.questions ?? []).filter((q) => typeof q === "string" && q.trim()).map((q) => q.trim()))]
        .filter((q) => !covered.has(q.toLowerCase()))
      if (!questions.length) return fail(400, "Ask at least one question it hasn't covered."), true
      if (questions.length > 3) return fail(400, "Ask 3 questions at most at a time."), true
      if (m.outline.length + questions.length > 12) return fail(400, "This mission can't take more questions. Start a new one."), true
      const followups = [...m.followups, { questions, from: m.outline.length, claims: m.ledger.claims.length, at: Date.now() }]
      if (!m.revisions.length) revise(m, "first")
      change(m, { followups, suggestions: [], pending: { reason: "followup", questions }, stage: "reading", error: null }, note)
      research(m, note)
      break
    }
    case "rewrite": {
      if (m.type === "compare") return fail(400, "Only a Learn & understand mission can be rewritten with another model."), true
      const failedRewrite = m.error && m.pending?.reason === "rewrite"
      if ((moved(["delivered"]) && !failedRewrite) || m.making) return fail(409, "The mission isn't delivered yet."), true
      const model = typeof body.model === "string" && body.model ? { provider: body.provider ?? "", model: body.model } : null
      if (model && !WRITERS)
        return fail(403, "This host doesn't let Gots pick the model. Allow it with `hermes plugins enable memento`."), true
      if (!m.revisions.length) revise(m, "first")
      change(m, { writer: model, pending: { reason: "rewrite", model }, suggestions: [], stage: "drafting", error: null }, note)
      write(m, note)
      break
    }
    case "retry":
      if (!m.error) return fail(409, "Nothing failed."), true
      change(m, { error: null }, note)
      if (m.stage === "reading") (m.type === "compare" ? compare : research)(m, note)
      else if (m.stage === "drafting") write(m, note)
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

/**
 * A literature review on the device. The brief form sends the question, the field, the years and
 * the criteria as edited; the Scope Gate sends the queries, the cap and whether preprints count; a
 * bot whose plugin can't review is refused before anything is posted. The canvas draws what the
 * plugin stored and counts nothing itself: the funnel, one row per included paper with the same
 * fields for each and how much of it was read, a row opening its quotes, the screened-out papers
 * with their reason, the themes with what stands behind each, a disagreement with both quotes, and
 * the reference list as the plugin wrote it. The table is wider than a phone and scrolls sideways
 * inside its card, whose geometry is the sweep's (`pnpm e2e research-literature`). What a paper is
 * screened as, what is kept of it and the funnel's sums are the plugin's
 * (`plugin/tests/test_literature.py`).
 */
import assert from "node:assert/strict"
import test from "node:test"

import { LiteratureBriefForm, LiteratureScopeForm, ReviewCanvas } from "@/components/literature"
import { Evidence, NowReading } from "@/components/research"
import { db } from "@/lib/db"
import {
  createMission,
  papersOf,
  sourcesOf,
  toMarkdown,
  typeOf,
  type Claim,
  type Mission,
  type Paper,
  type ReviewOutput,
  type Source,
} from "@/lib/research"
import {
  absent,
  absentText,
  botProfile,
  click,
  find,
  findAll,
  findText,
  json,
  mount,
  text,
  type,
} from "./component-kit.tsx"

const BRIEF = {
  field: "Cognitive psychology",
  fromYear: 2018,
  criteria: ["Human participants", "Measures working memory"],
  queries: ["sleep deprivation working memory", "nap recovery memory"],
  cap: 25,
  preprints: true,
}

function mission(patch: Partial<Mission> = {}): Mission {
  return {
    id: "r_1",
    profileId: "bot-1",
    type: "literature",
    input: "what does research say about sleep and working memory?",
    title: "Sleep loss and working memory",
    goal: "What does research say about sleep deprivation and working memory?",
    format: "review",
    audience: "",
    depth: "overview",
    outline: BRIEF.queries,
    sources: ["papers"],
    stage: "brief",
    createdAt: 1,
    found: 0,
    claimCount: 0,
    written: 0,
    formats: [],
    suggestions: [],
    options: [],
    criteria: [],
    review: BRIEF,
    ...patch,
  }
}

function host(features: string[]) {
  const posts: { path: string; body: unknown }[] = []
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input))
    if (url.pathname.endsWith("/info")) return json({ object: "gots.info", features })
    posts.push({ path: url.pathname, body: init?.body ? JSON.parse(String(init.body)) : undefined })
    return json({ mission: { id: "r_1", type: "literature", stage: "scope" } })
  }) as unknown as typeof fetch
  return posts
}

const paper = (
  id: string,
  title: string,
  authors: string[],
  patch: Partial<Paper> = {},
): Source => ({
  id,
  title,
  url: `https://doi.org/10.1/${id}`,
  kind: "papers",
  paper: {
    doi: `10.1/${id}`,
    year: 2021,
    venue: "Sleep",
    authors,
    preprint: false,
    screening: "include",
    reason: "",
    fails: "",
    level: "full",
    dropped: 0,
    ...patch,
  },
})

const SOURCES: Source[] = [
  paper("s1", "Sleep loss and working memory: a trial", ["Ada Okafor", "Lin Wei", "Marta Ruiz"]),
  paper("s2", "A short nap restores recall", ["Jonas Berg", "Priya Nair"], {
    preprint: true,
    level: "abstract",
    year: 2023,
  }),
  paper("s3", "Sleep deprivation in mice", ["Ken Ito"], {
    screening: "exclude",
    fails: "Human participants",
    reason: "An animal study.",
    level: undefined,
  }),
  paper("s4", "Shift workers and memory", ["Sofia Lindqvist"], {
    screening: "unsure",
    level: "metadata",
  }),
  paper("s5", "Never reached", ["Noor Rahman"], { screening: "unscreened", level: undefined }),
]

const claim = (id: string, source: string, field: Claim["field"], words: string): Claim => ({
  id,
  source,
  field,
  text: words,
  snippet: `${words} (the passage)`,
  confidence: "supported",
})

const CLAIMS: Claim[] = [
  claim("c1", "s1", "question", "Does a night awake impair working memory?"),
  claim("c2", "s1", "design", "trial"),
  claim("c3", "s1", "sample", "Sixty healthy adults."),
  claim("c4", "s1", "finding", "Accuracy fell by 12% after a night awake."),
  claim("c5", "s1", "limitation", "A small single-site sample."),
  claim("c6", "s2", "finding", "A short nap restored recall."),
]

const FUNNEL = {
  index: "OpenAlex",
  searchedAt: Date.UTC(2026, 10, 12),
  found: 9,
  duplicates: 2,
  screened: 4,
  included: 3,
  unsure: 1,
  excluded: { "Human participants": 1 },
  unscreened: 5,
}

const REVIEW: ReviewOutput = {
  themes: [
    {
      id: "t1",
      title: "What a night without sleep does",
      claims: ["c4", "c6"],
      papers: 2,
      full: 1,
      paragraphs: [
        [
          { text: "Accuracy fell after a night awake.", cites: ["c4"] },
          { text: " It always recovers.", flagged: true },
        ],
      ],
    },
  ],
  disagreements: [{ a: "c4", b: "c6", theme: "t1", about: "Whether the loss lasts." }],
  gaps: [[{ text: "The studies were small.", cites: ["c5"] }]],
  method: { ...BRIEF, index: "OpenAlex" },
  funnel: FUNNEL,
  read: { full: 1, abstract: 1, metadata: 1 },
  dropped: 2,
  references: [
    {
      source: "s1",
      text: "Ada Okafor, Lin Wei, Marta Ruiz (2021). Sleep loss and working memory: a trial. Sleep. https://doi.org/10.1/s1",
    },
    {
      source: "s2",
      text: "Jonas Berg, Priya Nair (2023). A short nap restores recall. Sleep. Preprint. https://doi.org/10.1/s2",
    },
  ],
}

const delivered = (patch: Partial<Mission> = {}) =>
  mission({
    stage: "delivered",
    formats: ["review"],
    funnel: FUNNEL,
    ledger: { sources: SOURCES, claims: CLAIMS },
    outputs: { review: REVIEW },
    ...patch,
  })

test("the review brief confirms the question, the field, the years and the edited criteria", async () => {
  const bot = botProfile("review-brief")
  await db.profiles.put(bot)
  const posts = host(["research", "research_literature"])
  await mount(<LiteratureBriefForm mission={mission()} />, async () => {
    assert.equal(
      (find('textarea[aria-label="Question"]') as HTMLTextAreaElement).value,
      "What does research say about sleep deprivation and working memory?",
    )
    assert.equal((find('input[aria-label="From year"]') as HTMLInputElement).value, "2018")
    assert.equal((find('input[aria-label="To year"]') as HTMLInputElement).value, "")
    assert.deepEqual(
      findAll('input[aria-label^="Criterion "]').map((one) => (one as HTMLInputElement).value),
      ["Human participants", "Measures working memory"],
    )
    await type(find('input[aria-label="To year"]'), "20x4")
    assert.ok(
      (findText("button", "Continue") as HTMLButtonElement).disabled,
      "a year that isn't one is not sent",
    )
    await type(find('input[aria-label="To year"]'), "2024")
    await type(find('input[aria-label="Field"]'), "Psychology")
    await click(find('button[aria-label="Remove criterion 2"]'))
    await click(findText("button", "Add a criterion"))
    await type(find('input[aria-label="Criterion 2"]'), "Adults")
    await click(findText("button", "Add a criterion"))
    await click(findText("button", "Continue"))
  })
  assert.deepEqual(posts, [
    {
      path: "/api/plugins/gots/research/r_1/brief",
      body: {
        goal: "What does research say about sleep deprivation and working memory?",
        field: "Psychology",
        from_year: 2018,
        to_year: 2024,
        criteria: ["Human participants", "Adults"],
      },
    },
  ])
  await db.profiles.delete(bot.id)
})

test("the review Scope Gate sends the queries, the cap and whether preprints count", async () => {
  const bot = botProfile("review-scope")
  await db.profiles.put(bot)
  const posts = host(["research", "research_literature"])
  await mount(<LiteratureScopeForm mission={mission({ stage: "scope" })} />, async () => {
    assert.deepEqual(
      findAll('input[aria-label^="Query "]').map((one) => (one as HTMLInputElement).value),
      BRIEF.queries,
    )
    assert.equal(
      findText('[role="radio"]', "25 papers")?.getAttribute("aria-checked"),
      "true",
      "25 papers until another is picked",
    )
    assert.equal(findText('[role="radio"]', "With preprints")?.getAttribute("aria-checked"), "true")
    await type(find('input[aria-label="Query 2"]'), "nap recall")
    await click(findText("button", "Add a query"))
    await click(findText('[role="radio"]', "40 papers"))
    await click(findText('[role="radio"]', "Without preprints"))
    await click(findText("button", "Approve and start research"))
  })
  assert.deepEqual(posts, [
    {
      path: "/api/plugins/gots/research/r_1/start",
      body: {
        queries: ["sleep deprivation working memory", "nap recall"],
        cap: 40,
        preprints: false,
      },
    },
  ])
  await db.profiles.delete(bot.id)
})

test("a review is refused where the plugin lacks research_literature", async () => {
  const posts = host(["research", "research_verify"])
  await assert.rejects(
    createMission(botProfile("review-old"), "sleep and working memory", "literature"),
    /needs an update for Literature review/,
  )
  assert.deepEqual(posts, [], "nothing is posted")
})

test("the review draws the plugin's funnel, a row per included paper and how much of each was read", async () => {
  const cited: string[] = []
  await mount(<ReviewCanvas mission={delivered()} onCite={(id) => cited.push(id)} />, async () => {
    const funnel = find("[data-funnel]")?.textContent ?? ""
    for (const stated of [
      /9Found/,
      /4Screened/,
      /3Included/,
      /1Read in full/,
      /1 excluded · Human participants/,
      /5 not reached before the cap/,
      /2 repeats folded/,
      /1 of 3 read in full · 1 at abstract only · 1 at metadata only/,
      /2 extracted fields dropped by the quote check/,
      /Searched OpenAlex/,
      /Since 2018/,
    ])
      assert.match(funnel, stated)

    // One row per included paper: the excluded and the unreached ones are not papers of the review.
    const rows = findAll("[data-paper]")
    assert.deepEqual(
      rows.map((row) => row.getAttribute("data-paper")),
      ["s1", "s2", "s4"],
    )
    const [first, second, third] = rows.map((row) => row.textContent ?? "")
    assert.match(first, /Okafor et al\., 2021/)
    assert.match(first, /Sixty healthy adults\./)
    assert.match(first, /Accuracy fell by 12% after a night awake\./)
    assert.match(first, /A small single-site sample\./)
    assert.match(first, /Full text/)
    assert.match(second, /Berg & Nair, 2023/)
    assert.match(second, /Preprint/)
    assert.match(second, /Abstract only/)
    assert.match(third, /Lindqvist, 2021/)
    assert.match(third, /Metadata only/)
    assert.doesNotMatch(first, /Preprint/)
    // Every paper has the same six cells, an empty one drawn as a dash.
    assert.ok(rows.every((row) => row.querySelectorAll("td").length === 6))
    assert.equal(rows[2].querySelectorAll("td")[3].textContent, "–")

    // The table is wider than a phone and scrolls inside its card rather than dropping a column.
    const card = find("[data-papers]") as HTMLElement
    assert.match(card.className, /overflow-x-auto/)
    assert.match(card.querySelector("table")!.className, /min-w-\[56rem\]/)
    assert.equal(card.querySelectorAll("thead th").length, 6)

    // A row opens its quotes, and closes again.
    absent("[data-quotes]")
    await click(first ? rows[0].querySelector("button[aria-expanded]") : null)
    const quotes = find('[data-quotes="s1"]')?.textContent ?? ""
    assert.match(quotes, /Key finding.*Accuracy fell by 12% after a night awake\. \(the passage\)/)
    assert.match(quotes, /Stated limitation/)
    assert.match(quotes, /Open the paper/)
    await click(rows[0].querySelector("button[aria-expanded]"))
    absent("[data-quotes]")

    // A cell's chip opens its claim in the Sources drawer.
    await click(rows[1].querySelector('button[aria-label="Source 6"]'))
  })
  assert.deepEqual(cited, ["c6"])
})

test("the review names what was screened out and why, its themes, a disagreement and the plugin's references", async () => {
  await mount(<ReviewCanvas mission={delivered()} onCite={() => undefined} />, async () => {
    const out = find("details")?.textContent ?? ""
    assert.match(out, /Screened out1/)
    assert.match(out, /Sleep deprivation in mice/)
    assert.match(out, /Screened out · Human participants · An animal study\./)
    assert.doesNotMatch(out, /Never reached/)

    const theme = find('[data-theme="t1"]')?.textContent ?? ""
    assert.match(theme, /What a night without sleep does/)
    assert.match(theme, /2 papers · 1 read in full/)
    assert.match(theme, /It always recovers\./)
    assert.match(theme, /No source/, "a sentence no claim backs is marked")

    const pair = find("[data-disagreements]")?.textContent ?? ""
    assert.match(pair, /Whether the loss lasts\./)
    assert.match(pair, /Accuracy fell by 12% after a night awake\. \(the passage\)/)
    assert.match(pair, /A short nap restored recall\. \(the passage\)/)
    assert.match(pair, /Okafor et al\., 2021/)
    assert.match(pair, /Berg & Nair, 2023/)

    assert.match(text(), /searched one index \(OpenAlex\) and read in full only what is openly/)
    const references = findAll("[data-references] li").map((one) => one.textContent ?? "")
    assert.equal(references.length, 2, "the references are the plugin's list, not the ledger's")
    assert.match(references[0], /^Ada Okafor, Lin Wei, Marta Ruiz \(2021\)\. Sleep loss/)
    assert.equal(find("[data-references] a")?.getAttribute("href"), "https://doi.org/10.1/s1")
    assert.doesNotMatch(text(), /systematic/i)
  })
})

test("a review still reading fills its funnel and table and waits for its themes", async () => {
  const reading = mission({
    stage: "reading",
    funnel: { ...FUNNEL, screened: 2, included: 1, unsure: 0, excluded: {}, unscreened: 7 },
    ledger: {
      sources: [SOURCES[0], paper("s2", "Still to read", ["Jonas Berg"], { level: undefined })],
      claims: CLAIMS.filter((c) => c.source === "s1"),
    },
  })
  await mount(<ReviewCanvas mission={reading} onCite={() => undefined} />, async () => {
    assert.match(find("[data-funnel]")?.textContent ?? "", /2Screened/)
    assert.match(find('[data-paper="s2"]')?.textContent ?? "", /Not read yet/)
    absent("[data-theme]")
    absent("[data-references]")
    absentText("h3", "Gaps and limits")
  })
  assert.equal(typeOf("literature").read(reading), "2 of 9 screened · 1 included · 1 read")
  assert.equal(typeOf("literature").read(mission({ stage: "reading" })), "Searching the index")
})

test("a review's sources are the papers it included, wherever they are counted", async () => {
  const review = delivered()
  assert.deepEqual(
    sourcesOf(review.ledger).map((source) => source.id),
    ["s1", "s2", "s4"],
  )
  assert.deepEqual(
    papersOf(review.ledger).map((row) => row.fields.finding.map((c) => c.id)),
    [["c4"], ["c6"], []],
  )
  await mount(<Evidence ledger={review.ledger} />, async () => {
    assert.match(text(), /6 claims from 2 sources/)
  })
  const working = mission({
    stage: "reading",
    ledger: {
      sources: [...SOURCES, paper("s6", "Only found", ["A B"], { screening: "found" })],
      claims: [],
    },
  })
  await mount(<NowReading mission={working} />, async () => {
    // The newest three whose screening is known, each saying where it stands.
    assert.doesNotMatch(text(), /Only found/)
    assert.match(text(), /Never reached2021 · Sleep · Not screened/)
    assert.match(text(), /Shift workers and memory2021 · Sleep · Metadata only/)
    assert.match(
      text(),
      /Sleep deprivation in mice2021 · Sleep · Screened out · Human participants/,
    )
  })
})

test("a review's Markdown carries its method, the papers table, the themes and the references", () => {
  const md = toMarkdown(delivered(), "review")
  assert.match(md, /^# Sleep loss and working memory\n\nA narrative review, not a systematic one\./)
  assert.match(md, /Index: OpenAlex, searched .*2026/)
  assert.match(md, /Years: Since 2018 · Preprints included · Up to 25 papers/)
  assert.match(md, /- sleep deprivation working memory/)
  assert.match(md, /- Human participants/)
  assert.match(md, /- 9 found in OpenAlex \(2 repeats folded\)/)
  assert.match(md, /- 4 screened, 5 not reached before the cap/)
  assert.match(md, /- 3 included \(1 unsure\)/)
  assert.match(md, /- 1 excluded: Human participants/)
  assert.match(md, /1 of 3 read in full/)
  assert.match(
    md,
    /\| Okafor et al\., 2021 \| trial\[2\] \| Sixty healthy adults\.\[3\] \| Accuracy fell by 12% after a night awake\.\[4\] \| A small single-site sample\.\[5\] \| Full text \|/,
  )
  assert.match(
    md,
    /\| Berg & Nair, 2023 \(preprint\) \| – \| – \| A short nap restored recall\.\[6\] \| – \| Abstract only \|/,
  )
  assert.match(md, /## What a night without sleep does\n\n2 papers, 1 read in full/)
  assert.match(md, /It always recovers\. \(no source\)/)
  assert.match(md, /## Where papers disagree\n\n- Whether the loss lasts\.\[4\]\[6\]/)
  assert.match(md, /## References\n\n- Ada Okafor, Lin Wei, Marta Ruiz \(2021\)\./)
  assert.match(md, /## Quotes\n\n\[2\] trial/)
})

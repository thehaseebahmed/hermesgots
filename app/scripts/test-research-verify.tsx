/**
 * A verification's brief. The form keeps the user's own words beside the plugin's neutral
 * restatement, lets the restatement and its parts be edited (one to four of them) and sends what was
 * edited; a claim the plugin read back as not checkable shows its read-back and nothing to confirm.
 * A bot whose plugin can't verify is refused before anything is posted. The verdict canvas draws the
 * plugin's stored verdict as it is: the label, its sentence and counts, each part's stance (a thin
 * one saying which way it leans), both lanes with their claims and searches, and what would change
 * it. What a claim is read back as and the verdict it gets are the plugin's
 * (`plugin/tests/test_research.py`); this never works either out.
 */
import assert from "node:assert/strict"
import test from "node:test"

import { VerdictCanvas, VerifyBriefForm, VerifyScopeForm } from "@/components/verify"
import { db } from "@/lib/db"
import { createMission, toMarkdown, type Mission, type Verdict } from "@/lib/research"
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

const loaded = "Coffee KILLS you: every daily cup is a heart attack waiting to happen!!"

function mission(patch: Partial<Mission> = {}): Mission {
  return {
    id: "r_1",
    profileId: "bot-1",
    type: "verify",
    input: loaded,
    title: "Coffee and heart attacks",
    goal: "",
    format: "guide",
    audience: "",
    depth: "overview",
    outline: [],
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
    verify: {
      restatement: "Drinking coffee daily raises the risk of a heart attack.",
      parts: [
        { id: "p1", text: "Coffee is drunk daily" },
        { id: "p2", text: "The risk of a heart attack rises" },
      ],
      terms: ["daily", "heart attack"],
    },
    ...patch,
  }
}

/** Answers `info` with the features given and records every other request it is sent. */
function host(features: string[]) {
  const posts: { path: string; body: unknown }[] = []
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input))
    if (url.pathname.endsWith("/info")) return json({ object: "gots.info", features })
    const body = init?.body ? JSON.parse(String(init.body)) : undefined
    posts.push({ path: url.pathname, body })
    return json({ mission: { id: "r_1", type: "verify", stage: "scope" } })
  }) as unknown as typeof fetch
  return posts
}

test("the verify brief keeps the original beside the restatement and confirms the edited parts", async () => {
  const bot = botProfile("verify-brief")
  await db.profiles.put(bot)
  const posts = host(["research", "research_verify"])
  await mount(<VerifyBriefForm mission={mission()} />, async () => {
    assert.match(text(), new RegExp(loaded.replace(/[!?]/g, "\\$&")), "the user's own words stay")
    const restatement = find('textarea[aria-label="Restatement"]') as HTMLTextAreaElement
    assert.equal(restatement.value, "Drinking coffee daily raises the risk of a heart attack.")
    assert.deepEqual(
      findAll('input[aria-label^="Term "]').map((term) => (term as HTMLInputElement).value),
      ["daily", "heart attack"],
    )
    assert.equal(findAll('input[aria-label^="Part "]').length, 2)

    await type(restatement, "Drinking coffee every day raises heart attack risk.")
    await type(find('input[aria-label="Part 2"]'), "Heart attack risk rises")
    await click(findText("button", "Add a part"))
    await click(findText("button", "Add a part"))
    assert.ok(
      (findText("button", "Add a part") as HTMLButtonElement).disabled,
      "four parts at most",
    )
    await click(find('button[aria-label="Remove part 1"]'))
    await type(find('input[aria-label="Term 1"]'), "every day")
    await click(find('button[aria-label="Remove term 2"]'))
    await click(findText("button", "Add a term"))
    await type(find('input[aria-label="Term 2"]'), "risk")
    await click(findText("button", "Continue"))
  })
  assert.deepEqual(posts, [
    {
      path: "/api/plugins/gots/research/r_1/brief",
      body: {
        restatement: "Drinking coffee every day raises heart attack risk.",
        parts: ["Heart attack risk rises"],
        terms: ["every day", "risk"],
      },
    },
  ])
  await db.profiles.delete(bot.id)
})

test("a claim read back as not checkable shows why and offers nothing to confirm", async () => {
  const uncheckable = mission({
    input: "Vim is the best editor",
    verify: {
      restatement: "Vim is the best editor.",
      parts: [{ id: "p1", text: "Vim is the best editor" }],
      terms: [],
      uncheckable: "It is a matter of taste.",
    },
  })
  await mount(<VerifyBriefForm mission={uncheckable} />, async () => {
    assert.match(text(), /Vim is the best editor\./)
    assert.match(text(), /It is a matter of taste\./)
    absentText("button", "Continue")
    absent("textarea", "nothing to edit")
  })
})

test("a verify mission is refused where the plugin lacks research_verify", async () => {
  const posts = host(["research", "research_compare"])
  await assert.rejects(
    createMission(botProfile("verify-old"), "Coffee raises heart attack risk", "verify"),
    /needs an update for Verify a claim/,
  )
  assert.deepEqual(posts, [], "nothing is posted")
})

test("the verify Scope Gate sends the kinds and the strictness", async () => {
  const bot = botProfile("verify-scope")
  await db.profiles.put(bot)
  const posts = host(["research", "research_verify"])
  const atScope = mission({
    stage: "scope",
    outline: ["Coffee is drunk daily", "The risk of a heart attack rises"],
  })
  await mount(<VerifyScopeForm mission={atScope} />, async () => {
    assert.match(text(), /Coffee is drunk daily/)
    assert.match(text(), /The risk of a heart attack rises/)
    absent('input[aria-label^="Part "]', "the parts are read-only here")
    absent('textarea[aria-label^="Point "]', "the parts are read-only here")
    const any = findText('[role="radio"]', "Any source")
    assert.equal(any.getAttribute("aria-checked"), "true", "any source until another is picked")
    await click(findText('[role="checkbox"]', "Articles and blogs"))
    await click(findText('[role="radio"]', "Primary and reputable"))
    await click(findText("button", "Approve and start research"))
  })
  assert.deepEqual(posts, [
    {
      path: "/api/plugins/gots/research/r_1/start",
      body: { source_kinds: ["papers", "articles"], strictness: "reputable" },
    },
  ])
  await db.profiles.delete(bot.id)
})

const SOURCES = [
  {
    id: "s1",
    title: "Coffee and heart health",
    url: "https://www.heart.org/coffee",
    kind: "articles",
  },
  { id: "s2", title: "A cohort of 500,000", url: "https://bmj.com/cohort", kind: "papers" },
  { id: "s3", title: "Caffeine and arrhythmia", url: "https://nejm.org/caffeine", kind: "papers" },
] as const

const CLAIMS = [
  {
    id: "c1",
    text: "Moderate coffee drinkers had fewer heart attacks.",
    source: "s2",
    stance: "refutes",
    lane: "against",
  },
  {
    id: "c2",
    text: "Heavy drinkers showed a small rise in risk.",
    source: "s1",
    stance: "supports",
    lane: "for",
  },
  {
    id: "c3",
    text: "Caffeine did not raise arrhythmia.",
    source: "s3",
    stance: "refutes",
    lane: "against",
  },
].map((c) => ({
  ...c,
  snippet: `${c.text} (passage)`,
  confidence: "supported" as const,
  part: "p1",
}))

const part = (patch: Partial<Verdict["parts"][number]>): Verdict["parts"][number] => ({
  part: "p1",
  stance: "supported",
  direction: null,
  supporting: 2,
  refuting: 0,
  for: ["c2"],
  against: [],
  ...patch,
})

/** A verification as the plugin delivers it: the stored verdict, read back as it was stored. */
function judged(verdict: Verdict, patch: Partial<Mission> = {}): Mission {
  const checked = Date.UTC(2026, 10, 9, 12)
  return mission({
    stage: "delivered",
    format: "verdict",
    formats: ["verdict"],
    found: 3,
    claimCount: 3,
    written: 1,
    outline: ["Coffee is drunk daily", "The risk of a heart attack rises"],
    searches: { for: ["coffee raises heart attack risk"], against: ["coffee lowers heart risk"] },
    ledger: { sources: [...SOURCES], claims: CLAIMS },
    verdict,
    outputs: {
      verdict: {
        tags: [],
        verdict,
        change: [[{ text: "A trial randomising coffee would settle it.", cites: ["c1"] }]],
        checkedAt: checked,
      },
    },
    ...patch,
  })
}

const parts = (p1: Partial<Verdict["parts"][number]>, p2: Partial<Verdict["parts"][number]>) => [
  part(p1),
  part({ part: "p2", ...p2 }),
]

const VERDICTS: { name: string; verdict: Verdict; label: string; stances: RegExp[] }[] = [
  {
    name: "supported",
    label: "Supported",
    verdict: {
      label: "supported",
      why: "Two or more independent sources back all 2 parts and none refute them.",
      sources: 2,
      leads: 0,
      parts: parts({}, { for: ["c2"] }),
    },
    stances: [/Supported/],
  },
  {
    name: "refuted",
    label: "Refuted",
    verdict: {
      label: "refuted",
      why: "Two or more independent sources refute 1 of 2 parts, with none backing that.",
      sources: 2,
      leads: 0,
      parts: parts(
        { stance: "refuted", supporting: 0, refuting: 2, for: [], against: ["c1", "c3"] },
        { stance: "cant_tell", supporting: 0, refuting: 0, for: [] },
      ),
    },
    stances: [/Refuted/, /Can't tell/],
  },
  {
    name: "disputed",
    label: "Disputed",
    verdict: {
      label: "disputed",
      why: "Independent sources disagree on 1 of 2 parts.",
      sources: 2,
      leads: 0,
      parts: parts(
        { stance: "disputed", supporting: 1, refuting: 1, against: ["c1"] },
        { stance: "not_supported", supporting: 0, for: [] },
      ),
    },
    stances: [/Disputed/, /Not supported/],
  },
  {
    name: "thin",
    label: "Thin evidence",
    verdict: {
      label: "thin",
      why: "Only one source bears on it, and it leans against.",
      sources: 1,
      leads: 1,
      parts: parts(
        {
          stance: "thin",
          direction: "refutes",
          supporting: 0,
          refuting: 1,
          for: [],
          against: ["c1"],
        },
        { stance: "thin", direction: "supports", supporting: 1 },
      ),
    },
    stances: [/Thin, leans against/, /Thin, leans for/],
  },
  {
    name: "cant_tell",
    label: "Can't tell",
    verdict: {
      label: "cant_tell",
      why: "Evidence was found, but none of it takes a side.",
      sources: 0,
      leads: 0,
      parts: parts(
        { stance: "cant_tell", supporting: 0, for: [] },
        { stance: "cant_tell", supporting: 0, for: [] },
      ),
    },
    stances: [/Can't tell/],
  },
  {
    name: "not_supported",
    label: "Not supported",
    verdict: {
      label: "not_supported",
      why: "No evidence was found for or against it.",
      sources: 0,
      leads: 2,
      parts: parts(
        { stance: "not_supported", supporting: 0, for: [] },
        { stance: "not_supported", supporting: 0, for: [] },
      ),
    },
    stances: [/Not supported/],
  },
  {
    name: "partly_supported",
    label: "Partly supported",
    verdict: {
      label: "partly_supported",
      why: "Two or more independent sources back 1 of 2 parts, but not the rest.",
      sources: 2,
      leads: 0,
      parts: parts({}, { stance: "not_supported", supporting: 0, for: [] }),
    },
    stances: [/Supported/, /Not supported/],
  },
]

const noop = () => undefined

test("the verdict card, the parts, both lanes and their searches are drawn from the plugin's verdict", async (t) => {
  for (const { name, verdict, label, stances } of VERDICTS)
    await t.test(name, async () => {
      await mount(<VerdictCanvas mission={judged(verdict)} onCite={noop} />, async () => {
        const card = find("[data-verdict]")
        assert.equal(find("[data-verdict] h3")?.textContent, label, "the label as a word")
        assert.match(card?.textContent ?? "", new RegExp(verdict.why), "its sentence")
        assert.match(
          card?.textContent ?? "",
          new RegExp(
            `${verdict.sources} independent ${verdict.sources === 1 ? "source" : "sources"}`,
          ),
        )
        assert.match(card?.textContent ?? "", /Checked .*2026/, "the date checked")
        if (verdict.leads)
          assert.match(
            card?.textContent ?? "",
            new RegExp(`${verdict.leads} unverifiable ${verdict.leads === 1 ? "lead" : "leads"}`),
          )
        else assert.doesNotMatch(card?.textContent ?? "", /unverifiable/)

        const rows = findAll("[data-parts] tbody tr")
        assert.equal(rows.length, 2, "a row per part")
        assert.match(rows[0].textContent ?? "", /Coffee is drunk daily/)
        assert.match(rows[1].textContent ?? "", /The risk of a heart attack rises/)
        const table = find("[data-parts]")?.textContent ?? ""
        for (const stance of stances) assert.match(table, stance)
        assert.match(
          rows[0].textContent ?? "",
          new RegExp(`${verdict.parts[0].supporting}\\D*${verdict.parts[0].refuting}`),
          "its counts",
        )

        assert.match(text(), /What would change this/)
        assert.match(text(), /A trial randomising coffee would settle it\./)
      })
    })
})

test("each lane lists its claims and its searches, and a claim opens its source", async () => {
  const cited: string[] = []
  const verdict = VERDICTS[0].verdict
  const quiet = judged(verdict, {
    ledger: { sources: [...SOURCES], claims: CLAIMS.filter((c) => c.lane === "against") },
    searches: {
      for: ["coffee heart attack meta-analysis", "coffee causes heart attacks"],
      against: [],
    },
  })
  await mount(<VerdictCanvas mission={quiet} onCite={(id) => cited.push(id)} />, async () => {
    const lane = (name: string) => find(`[data-lane="${name}"]`)?.textContent ?? ""
    assert.match(
      lane("for"),
      /coffee heart attack meta-analysis/,
      "an empty lane still shows its searches",
    )
    assert.match(lane("for"), /coffee causes heart attacks/)
    assert.doesNotMatch(lane("for"), /Moderate coffee drinkers/)
    assert.match(lane("against"), /Moderate coffee drinkers had fewer heart attacks\./)
    assert.match(lane("against"), /Caffeine did not raise arrhythmia\./)
    assert.match(lane("against"), /None/, "a lane that searched nothing says so")
    await click(findText('[data-lane="against"] button', "Caffeine did not raise arrhythmia."))
  })
  assert.deepEqual(cited, ["c3"])
})

test("a verdict's Markdown carries the label, the parts, both lanes and what would change it", () => {
  const md = toMarkdown(judged(VERDICTS[3].verdict), "verdict")
  assert.match(md, /Thin evidence/)
  assert.match(md, /Only one source bears on it, and it leans against\./)
  assert.match(md, /Coffee is drunk daily.*Thin, leans against/)
  assert.match(md, /## For[\s\S]*Heavy drinkers showed a small rise in risk\.[\s\S]*heart\.org/)
  assert.match(md, /## Against[\s\S]*Moderate coffee drinkers had fewer heart attacks\./)
  assert.match(md, /coffee lowers heart risk/)
  assert.match(md, /## What would change this[\s\S]*A trial randomising coffee would settle it\./)
  assert.match(md, /Checked .*2026/)
})

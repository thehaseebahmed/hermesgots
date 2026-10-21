/**
 * A comparison's memo and brief. The memo reads the plugin's decision as it is: the leader named, a
 * close call said, an option that is ruled out marked, a score no claim backs shown as thin, and a
 * cell opening its reason. The brief keeps two options and two criteria at least. The ranking
 * itself is the plugin's code (`decide`, tested in `plugin/tests/test_research.py`); this never
 * works one out. How the scores table fits a phone is layout, which the browser sweep owns.
 */
import assert from "node:assert/strict"
import test from "node:test"

import { CompareBriefForm, MemoCanvas } from "@/components/compare"
import type { Cell, Mission } from "@/lib/research"
import { click, find, findAll, findText, mount, text } from "./component-kit.tsx"

const cell = (score: number | null, reason: string, claims: string[]): Cell => ({
  score,
  reason,
  claims,
  flagged: claims.length === 0,
})

const options = [
  { id: "o1", name: "Bun" },
  { id: "o2", name: "Node.js" },
  { id: "o3", name: "Deno" },
]
const criteria = [
  { id: "k1", name: "Speed", weight: 4 },
  { id: "k2", name: "Ecosystem", weight: 5 },
]
const prose = (sentence: string, cites: string[]) => [[{ text: sentence, cites }]]

function mission(patch: Partial<Mission> = {}): Mission {
  return {
    id: "r_1",
    profileId: "bot-1",
    type: "compare",
    input: "Bun, Node.js or Deno?",
    title: "Bun, Node.js or Deno",
    goal: "Decide which runtime to build on.",
    format: "memo",
    audience: "A developer",
    depth: "overview",
    outline: ["Speed", "Ecosystem"],
    sources: ["docs"],
    stage: "delivered",
    createdAt: 1,
    found: 2,
    claimCount: 4,
    written: 7,
    formats: ["memo"],
    suggestions: [],
    options,
    criteria,
    decision: {
      ranking: [
        { option: "o2", total: 84, ruledOut: false, thin: [] },
        { option: "o1", total: 82, ruledOut: false, thin: [] },
        { option: "o3", total: 40, ruledOut: true, thin: ["k2"] },
      ],
      leader: "o2",
      margin: 2,
      close: true,
    },
    outputs: {
      memo: {
        options: options.map((o) => ({
          ...o,
          case: prose(`The case for ${o.name}.`, ["c1"]),
          rebuttal: [],
        })),
        scores: {
          o1: {
            k1: cell(9, "Starts fastest.", ["c1"]),
            k2: cell(6, "Runs most packages.", ["c2"]),
          },
          o2: { k1: cell(6, "No advantage.", ["c3"]), k2: cell(10, "The largest.", ["c4"]) },
          o3: { k1: cell(6, "Quick.", ["c5"]), k2: cell(3, "", []) },
        },
        ruledOut: [{ option: "o3", criterion: "k2", claim: "c6" }],
        verdict: prose("Node.js leads on ecosystem.", ["c4"]),
        flip: prose("Full package support would flip it.", ["c2"]),
      },
    },
    ...patch,
  }
}

const noop = () => undefined

test("the memo names the leader, says when it is close and marks what is ruled out or thin", async () => {
  await mount(<MemoCanvas mission={mission()} onCite={noop} />, async () => {
    assert.ok(findText("h3", "Node.js leads"), "the leader is the headline")
    assert.match(text(), /Close call with Bun/, "a margin inside the tie band says so")
    assert.match(text(), /What would change this/)
    assert.equal(findAll('[aria-label="Thin"]').length, 1, "a score no claim backs is thin")
    assert.match(
      find("tbody")?.textContent ?? "",
      /Deno\s*Ruled out/,
      "the ruled-out option says so",
    )
    assert.match(text(), /84/)
  })
})

test("a comparison that isn't clear says nothing about a close call", async () => {
  const clear = mission({
    decision: { ...mission().decision!, margin: 20, close: false },
  })
  await mount(<MemoCanvas mission={clear} onCite={noop} />, async () => {
    assert.ok(findText("h3", "Node.js leads"))
    assert.doesNotMatch(text(), /Close call/)
  })
})

test("a cell opens the judge's reason, and a thin one says no claim backs it", async () => {
  await mount(<MemoCanvas mission={mission()} onCite={noop} />, async () => {
    await click(find('button[aria-label="Bun on Speed"]'))
    assert.match(find("[role=dialog]")?.textContent ?? "", /Starts fastest\./)
    assert.doesNotMatch(find("[role=dialog]")?.textContent ?? "", /No claim backs this score/)
  })
  await mount(<MemoCanvas mission={mission()} onCite={noop} />, async () => {
    await click(find('button[aria-label="Deno on Ecosystem"]'))
    const dialog = find("[role=dialog]")?.textContent ?? ""
    assert.match(dialog, /No claim backs this score/)
    assert.match(dialog, /Ruled out here/, "a ruling shows where it applies")
  })
})

test("while the memo is being written it shows the cases so far and no ranking", async () => {
  const drafting = mission({
    stage: "drafting",
    written: 1,
    decision: { ranking: [], close: false },
    outputs: {
      memo: {
        options: options.map((o, i) => ({
          ...o,
          case: i === 0 ? prose("Bun's case.", ["c1"]) : [],
          rebuttal: [],
        })),
        ruledOut: [],
        verdict: [],
        flip: [],
      },
    },
  })
  await mount(<MemoCanvas mission={drafting} onCite={noop} />, async () => {
    assert.ok(findText("h3", "Verdict"), "no leader before the judge has scored")
    assert.equal(find("table"), null, "no scores table before the judge has scored")
    assert.match(text(), /Bun's case\./)
  })
})

test("the brief keeps at least two options and two criteria", async () => {
  const brief = mission({
    stage: "brief",
    options: options.slice(0, 2),
    criteria: [...criteria, { id: "k3", name: "Stability", weight: 3 }],
    outputs: undefined,
  })
  await mount(<CompareBriefForm mission={brief} />, async () => {
    assert.ok(
      (find('button[aria-label="Remove option 1"]') as HTMLButtonElement).disabled,
      "two options stay",
    )
    assert.equal(
      (find('button[aria-label="Remove criterion 1"]') as HTMLButtonElement).disabled,
      false,
      "three criteria can lose one",
    )
    await click(find('button[aria-label="Remove criterion 1"]'))
    assert.ok(
      (find('button[aria-label="Remove criterion 1"]') as HTMLButtonElement).disabled,
      "two criteria stay",
    )
    const proceed = findText("button", "Continue") as HTMLButtonElement
    assert.equal(proceed.disabled, false, "a valid brief can continue")
    await click(find('button[aria-label="Add an option"]') ?? findText("button", "Add an option"))
    assert.equal(
      (findText("button", "Continue") as HTMLButtonElement).disabled,
      false,
      "an empty extra option is left out, not counted",
    )
  })
})

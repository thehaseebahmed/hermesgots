/**
 * The roadmap's data, in the shape the app site's roadmap function serves
 * (`app/netlify/lib/roadmap.ts`, `GET ?route=board`), and the markup the page draws it with. Until
 * the site has `PUBLIC_COMMUNITY_URL` (the app site's base URL) it shows a sample, marked as such.
 */

export const STATUSES = [
  { key: "building", label: "In progress" },
  { key: "planned", label: "Planned" },
  { key: "shipped", label: "Shipped" },
] as const
export type Status = (typeof STATUSES)[number]["key"]

export interface Feature {
  id: string
  title: string
  summary: string
  status: Status
  url: string
  issue: { owner: string; repo: string; number: number }
  votes: number
}

export interface Roadmap {
  features: Feature[]
  signedIn: boolean
  admin: boolean
  voted: string[]
}

const isStatus = (value: unknown): value is Status => STATUSES.some((s) => s.key === value)

function readFeature(value: unknown): Feature | null {
  if (!value || typeof value !== "object") return null
  const f = value as Record<string, unknown>
  const issue = f.issue as Record<string, unknown> | undefined
  if (
    typeof f.id !== "string" ||
    typeof f.title !== "string" ||
    typeof f.url !== "string" ||
    !f.url.startsWith("https://github.com/") ||
    !isStatus(f.status) ||
    typeof f.votes !== "number" ||
    !issue ||
    typeof issue.owner !== "string" ||
    typeof issue.repo !== "string" ||
    typeof issue.number !== "number"
  ) {
    return null
  }
  return {
    id: f.id,
    title: f.title,
    summary: typeof f.summary === "string" ? f.summary : "",
    status: f.status,
    url: f.url,
    issue: { owner: issue.owner, repo: issue.repo, number: issue.number },
    votes: f.votes,
  }
}

/** A board as the function answers it, or null for anything else. */
export function readRoadmap(value: unknown): Roadmap | null {
  if (!value || typeof value !== "object") return null
  const r = value as Record<string, unknown>
  if (!Array.isArray(r.features)) return null
  return {
    features: r.features.map(readFeature).filter((f): f is Feature => f !== null),
    signedIn: r.signedIn === true,
    admin: r.admin === true,
    voted: Array.isArray(r.voted) ? r.voted.filter((id) => typeof id === "string") : [],
  }
}

const sampleIssue = (number: number) => ({ owner: "thehaseebahmed", repo: "hermesgots", number })
const sampleUrl = (number: number) => `https://github.com/thehaseebahmed/hermesgots/issues/${number}`

export function sampleRoadmap(): Roadmap {
  const features: Feature[] = [
    {
      id: "sample0001",
      title: "Rooms on every bot",
      summary: "Bring several bots into one conversation and let them answer each other.",
      status: "building",
      issue: sampleIssue(1),
      url: sampleUrl(1),
      votes: 41,
    },
    {
      id: "sample0002",
      title: "An iPhone app",
      summary: "Gots as a native iOS app, with share and notifications.",
      status: "planned",
      issue: sampleIssue(2),
      url: sampleUrl(2),
      votes: 87,
    },
    {
      id: "sample0003",
      title: "Voice replies",
      summary: "Hear a bot's answer read aloud in its own voice.",
      status: "planned",
      issue: sampleIssue(3),
      url: sampleUrl(3),
      votes: 23,
    },
    {
      id: "sample0004",
      title: "Dictation",
      summary: "Talk to a bot and the host writes it down.",
      status: "shipped",
      issue: sampleIssue(4),
      url: sampleUrl(4),
      votes: 64,
    },
  ]
  return { features: ranked(features), signedIn: false, admin: false, voted: [] }
}

const escape = (value: string) => value.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`)

const ARROW =
  '<svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><path d="M12 5l7 8h-4.5v6h-5v-6H5z" fill="currentColor"/></svg>'

export interface RenderOptions {
  /** The sample's votes are shown but can't be cast. */
  live: boolean
  voted: Set<string>
  admin: boolean
  /** A vote on its way: its button waits. */
  busy: Set<string>
}

function card(f: Feature, o: RenderOptions) {
  const on = o.voted.has(f.id)
  const shipped = f.status === "shipped"
  const noun = f.votes === 1 ? "vote" : "votes"
  const label = shipped
    ? `${f.votes} ${noun}`
    : `${on ? "Remove your vote for" : "Vote for"} ${f.title}, ${f.votes} ${noun}`
  const disabled = !o.live || shipped || o.busy.has(f.id)
  const vote = `<button type="button" class="vote" data-vote="${escape(f.id)}" aria-pressed="${on}" aria-label="${escape(label)}"${disabled ? " disabled" : ""}>${ARROW}<span>${f.votes}</span></button>`
  const link = `<a class="road-link" href="${escape(f.url)}" target="_blank" rel="noreferrer">
      <b>${escape(f.title)}${shipped ? ' <em class="road-tag">Shipped</em>' : ""}</b>
      ${f.summary ? `<span>${escape(f.summary)}</span>` : ""}
    </a>`
  const tools = o.admin
    ? `<div class="road-tools">
        <button type="button" class="link" data-edit="${escape(f.id)}">Edit</button>
        <button type="button" class="link danger" data-remove="${escape(f.id)}">Remove</button>
      </div>`
    : ""
  return `<li class="road-card${o.admin ? " has-tools" : ""}">${vote}${link}${tools}</li>`
}

/**
 * Most votes first. The sort is stable, so a tie keeps the order the board gave it (the older
 * feature first), and a vote cast here moves its feature without asking for the board again.
 */
export const ranked = (features: Feature[]) => [...features].sort((a, b) => b.votes - a.votes)

/** Every feature on a card of its own, in the board's rank order (most votes first). */
export function roadmapHtml(features: Feature[], o: RenderOptions) {
  if (!features.length) return '<p class="empty">Nothing on the roadmap yet.</p>'
  return `<ol class="road-cards">${ranked(features).map((f) => card(f, o)).join("")}</ol>`
}

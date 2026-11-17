/**
 * The roadmap: features an admin lists, each pointing at the GitHub issue that describes it, and a
 * vote per feature per signed-in account.
 *
 * The list is one document (`roadmap/features`), written only by an admin and on the etag it read,
 * so two admins editing at once can't lose a write. A vote is a key of its own,
 * `roadmap/votes/<feature>/<voter>`, so a vote is the key existing: casting twice writes the same
 * key, and no count can drift from the votes it counts because the count is the keys, listed when
 * the board is read. The voter is a hash of the Identity account id, never the id itself, so the
 * store holds nothing that names a person.
 *
 * An admin is an account carrying the Identity role `admin` (`app_metadata.roles`), which only the
 * site's owner can give, in Netlify's Identity settings. Nothing a user can write about themselves
 * (their name, their avatar) makes them one.
 */

import { sha256, type RegistryStore } from "./registry.ts"

export const STATUSES = ["planned", "building", "shipped"] as const
export type Status = (typeof STATUSES)[number]

export interface Issue {
  owner: string
  repo: string
  number: number
}

export interface Feature {
  id: string
  title: string
  summary: string
  issue: Issue
  status: Status
  createdAt: number
  updatedAt: number
}

/** A feature as the board serves it. */
export interface FeatureRow extends Feature {
  url: string
  votes: number
}

export type RoadmapCaller = { userId: string; roles?: string[] } | null

export interface RoadmapContext {
  store: RegistryStore
  caller: RoadmapCaller
  /** An issue's title from GitHub, or null when GitHub has no such issue. */
  issueTitle: (issue: Issue) => Promise<string | null>
  now?: number
}

const FEATURES = "roadmap/features"
const votePrefix = (id: string) => `roadmap/votes/${id}/`
const MAX_FEATURES = 100
const MAX_TITLE = 120
const MAX_SUMMARY = 500
const MAX_BYTES = 16 * 1024
const ID = /^[a-z0-9]{10}$/
const OWNER = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/
const REPO = /^[A-Za-z0-9._-]{1,100}$/
const ISSUE_URL = /^https:\/\/github\.com\/([^/]+)\/([^/]+)\/issues\/(\d{1,9})\/?(?:[?#].*)?$/

function json(body: unknown, status = 200) {
  return Response.json(body, { status, headers: { "Cache-Control": "no-store" } })
}

const error = (message: string, status: number) => json({ error: message }, status)

/** The issue a GitHub issue URL names, or null for anything else. */
export function issueOf(raw: unknown): Issue | null {
  if (typeof raw !== "string") return null
  const match = ISSUE_URL.exec(raw.trim())
  if (!match) return null
  const [, owner, repo, number] = match
  if (!OWNER.test(owner!) || !REPO.test(repo!)) return null
  const n = Number(number)
  return n > 0 ? { owner: owner!, repo: repo!, number: n } : null
}

export const issueUrl = (issue: Issue) =>
  `https://github.com/${issue.owner}/${issue.repo}/issues/${issue.number}`

/** The Identity role that may edit the list. */
export const ADMIN_ROLE = "admin"

export function isAdmin(caller: RoadmapCaller) {
  return caller?.roles?.includes(ADMIN_ROLE) ?? false
}

const voterOf = (userId: string) => sha256(`gots:roadmap:${userId}`)

function text(raw: unknown, max: number) {
  if (raw === undefined) return undefined
  if (typeof raw !== "string") return null
  const value = raw.replace(/\s+/g, " ").trim()
  return value.length <= max ? value : null
}

function statusOf(raw: unknown): Status | null | undefined {
  if (raw === undefined) return undefined
  return (STATUSES as readonly unknown[]).includes(raw) ? (raw as Status) : null
}

function newId() {
  const alphabet = "abcdefghijklmnopqrstuvwxyz0123456789"
  const bytes = crypto.getRandomValues(new Uint8Array(10))
  return Array.from(bytes, (b) => alphabet[b % alphabet.length]).join("")
}

async function readFeatures(store: RegistryStore) {
  const entry = await store.getWithMetadata(FEATURES, { type: "json" })
  const list = (entry?.data as { features?: Feature[] } | undefined)?.features
  return { features: Array.isArray(list) ? list : [], etag: entry?.etag }
}

/** Change the list on the etag read, retrying when another admin wrote in between. */
async function updateFeatures(
  store: RegistryStore,
  change: (features: Feature[]) => Feature[] | Response,
): Promise<Feature[] | Response> {
  for (let attempt = 0; attempt < 5; attempt++) {
    const { features, etag } = await readFeatures(store)
    const next = change(features)
    if (next instanceof Response) return next
    const result = await store.setJSON(
      FEATURES,
      { features: next },
      etag ? { onlyIfMatch: etag } : { onlyIfNew: true },
    )
    if (result.modified) return next
  }
  return error("The roadmap changed while saving; try again", 409)
}

/** Votes per feature, and the features this voter voted for. */
async function tally(store: RegistryStore, voter: string | null) {
  const counts = new Map<string, number>()
  const mine = new Set<string>()
  const { blobs } = await store.list({ prefix: "roadmap/votes/" })
  for (const { key } of blobs) {
    const [, , feature, who] = key.split("/")
    if (!feature || !who) continue
    counts.set(feature, (counts.get(feature) ?? 0) + 1)
    if (who === voter) mine.add(feature)
  }
  return { counts, mine }
}

const ORDER: Record<Status, number> = { building: 0, planned: 1, shipped: 2 }

/** The board's order: what's being built, then planned, then shipped; most votes first in each. */
export function ordered(rows: FeatureRow[]) {
  return [...rows].sort(
    (a, b) => ORDER[a.status] - ORDER[b.status] || b.votes - a.votes || a.createdAt - b.createdAt,
  )
}

async function body(req: Request): Promise<Record<string, unknown> | null> {
  const raw = await req.text()
  if (raw.length > MAX_BYTES) return null
  try {
    const value = JSON.parse(raw)
    return value && typeof value === "object" && !Array.isArray(value) ? value : null
  } catch {
    return null
  }
}

async function board(ctx: RoadmapContext) {
  const voter = ctx.caller ? await voterOf(ctx.caller.userId) : null
  const [{ features }, { counts, mine }] = await Promise.all([
    readFeatures(ctx.store),
    tally(ctx.store, voter),
  ])
  const rows = features.map((f) => ({ ...f, url: issueUrl(f.issue), votes: counts.get(f.id) ?? 0 }))
  return json({
    features: ordered(rows),
    signedIn: ctx.caller !== null,
    admin: isAdmin(ctx.caller),
    voted: features.filter((f) => mine.has(f.id)).map((f) => f.id),
  })
}

async function vote(req: Request, ctx: RoadmapContext, id: string) {
  if (!ctx.caller) return error("Sign in to vote", 401)
  const { features } = await readFeatures(ctx.store)
  const feature = features.find((f) => f.id === id)
  if (!feature) return error("No such feature", 404)
  const key = `${votePrefix(id)}${await voterOf(ctx.caller.userId)}`
  if (req.method === "POST") {
    if (feature.status === "shipped") return error("This feature has shipped", 409)
    await ctx.store.setJSON(key, { at: ctx.now ?? Date.now() })
  } else {
    await ctx.store.delete(key)
  }
  const { blobs } = await ctx.store.list({ prefix: votePrefix(id) })
  return json({ id, votes: blobs.length, voted: req.method === "POST" })
}

async function create(req: Request, ctx: RoadmapContext) {
  const input = await body(req)
  if (!input) return error("Invalid body", 400)
  const issue = issueOf(input.issue)
  if (!issue) return error("Give a GitHub issue link (https://github.com/owner/repo/issues/1)", 400)
  const summary = text(input.summary, MAX_SUMMARY)
  const status = statusOf(input.status)
  let title = text(input.title, MAX_TITLE)
  if (summary === null || status === null || title === null) return error("Invalid feature", 400)
  if (!title) {
    try {
      title = (await ctx.issueTitle(issue))?.slice(0, MAX_TITLE) ?? null
    } catch {
      return error("Couldn't read the issue from GitHub; give a title", 502)
    }
    if (!title) return error("GitHub has no such issue; give a title or check the link", 400)
  }
  const now = ctx.now ?? Date.now()
  const feature: Feature = {
    id: newId(),
    title,
    summary: summary ?? "",
    issue,
    status: status ?? "planned",
    createdAt: now,
    updatedAt: now,
  }
  const result = await updateFeatures(ctx.store, (features) => {
    if (features.length >= MAX_FEATURES) return error("The roadmap is full", 409)
    const same = issueUrl(issue).toLowerCase()
    if (features.some((f) => issueUrl(f.issue).toLowerCase() === same)) {
      return error("That issue is already on the roadmap", 409)
    }
    return [...features, feature]
  })
  if (result instanceof Response) return result
  return json({ feature: { ...feature, url: issueUrl(issue), votes: 0 } }, 201)
}

async function edit(req: Request, ctx: RoadmapContext, id: string) {
  const input = await body(req)
  if (!input) return error("Invalid body", 400)
  const title = text(input.title, MAX_TITLE)
  const summary = text(input.summary, MAX_SUMMARY)
  const status = statusOf(input.status)
  const issue = input.issue === undefined ? undefined : issueOf(input.issue)
  if (title === null || title === "" || summary === null || status === null || issue === null) {
    return error("Invalid feature", 400)
  }
  let edited: Feature | null = null
  const result = await updateFeatures(ctx.store, (features) => {
    const at = features.findIndex((f) => f.id === id)
    if (at < 0) return error("No such feature", 404)
    if (issue) {
      const same = issueUrl(issue).toLowerCase()
      const taken = features.some((f) => f.id !== id && issueUrl(f.issue).toLowerCase() === same)
      if (taken) return error("That issue is already on the roadmap", 409)
    }
    const before = features[at]!
    edited = {
      ...before,
      title: title ?? before.title,
      summary: summary ?? before.summary,
      status: status ?? before.status,
      issue: issue ?? before.issue,
      updatedAt: ctx.now ?? Date.now(),
    }
    return features.map((f, i) => (i === at ? edited! : f))
  })
  if (result instanceof Response) return result
  return json({ feature: edited })
}

async function remove(ctx: RoadmapContext, id: string) {
  const result = await updateFeatures(ctx.store, (features) =>
    features.some((f) => f.id === id)
      ? features.filter((f) => f.id !== id)
      : error("No such feature", 404),
  )
  if (result instanceof Response) return result
  const { blobs } = await ctx.store.list({ prefix: votePrefix(id) })
  await Promise.all(blobs.map(({ key }) => ctx.store.delete(key)))
  return json({ removed: id })
}

export async function handleRoadmap(req: Request, ctx: RoadmapContext): Promise<Response> {
  const url = new URL(req.url)
  const route = url.searchParams.get("route")
  const id = url.searchParams.get("id") ?? ""
  if (route === "board" && req.method === "GET") return board(ctx)
  if (route === "vote" && (req.method === "POST" || req.method === "DELETE")) {
    if (!ID.test(id)) return error("No such feature", 404)
    return vote(req, ctx, id)
  }
  if (route === "feature") {
    if (!ctx.caller) return error("Sign in first", 401)
    if (!isAdmin(ctx.caller)) return error("Only an admin can edit the roadmap", 403)
    if (req.method === "POST") return create(req, ctx)
    if (!ID.test(id)) return error("No such feature", 404)
    if (req.method === "PATCH") return edit(req, ctx, id)
    if (req.method === "DELETE") return remove(ctx, id)
  }
  return error("Not found", 404)
}

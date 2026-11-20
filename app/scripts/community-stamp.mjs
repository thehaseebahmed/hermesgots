/**
 * The backfill for accounts that signed up before the signup hook (ADR 0166): it lists the
 * Identity accounts with no `app_metadata.github_id` and, one at a time, asks which GitHub account
 * each belongs to, writing the answer through `community?route=stamp`.
 *
 * Nothing an account holds proves its GitHub id — its avatar is the user's own to rewrite — so the
 * avatar's id is shown only as what the account claims. Stamp it only for a person you know. The
 * routes need the Identity role `admin` (Netlify's site settings, Identity, the user's roles), and
 * the token is that admin's own session: the `nf_jwt` cookie of the signed-in app.
 *
 *   GOTS_SITE=https://<app> GOTS_ADMIN_TOKEN=<nf_jwt> pnpm community-stamp
 */
import { createInterface } from "node:readline/promises"

const site = (process.env.GOTS_SITE ?? "").replace(/\/+$/, "")
const token = process.env.GOTS_ADMIN_TOKEN ?? ""
if (!site || !token) {
  console.error("Set GOTS_SITE to the app's address and GOTS_ADMIN_TOKEN to an admin's nf_jwt.")
  process.exit(2)
}

const route = (name) => `${site}/.netlify/functions/community?route=${name}`
const auth = { Authorization: `Bearer ${token}` }

async function call(name, init = {}) {
  const res = await fetch(route(name), { ...init, headers: { ...auth, ...init.headers } })
  const body = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error(body.error ?? `The site answered ${res.status}`)
  return body
}

const github = (path) =>
  fetch(`https://api.github.com/${path}`, {
    headers: { Accept: "application/vnd.github+json", "User-Agent": "gots-community-stamp" },
  }).then((res) => (res.ok ? res.json() : null))

const { accounts } = await call("unstamped")
if (accounts.length === 0) {
  console.log("Every account carries a GitHub id.")
  process.exit(0)
}

const ask = createInterface({ input: process.stdin, output: process.stdout })
let stamped = 0
for (const account of accounts) {
  const claimed = account.claimedGithubId ? await github(`user/${account.claimedGithubId}`) : null
  console.log(`\n${account.email ?? account.id} (${account.provider ?? "no provider"})`)
  console.log(claimed ? `  its avatar claims @${claimed.login}` : "  its avatar claims nobody")
  const answer = (
    await ask.question("  GitHub username to stamp (empty skips, y takes the claim): ")
  ).trim()
  if (!answer) continue
  const user = answer === "y" ? claimed : await github(`users/${encodeURIComponent(answer)}`)
  if (!user?.id) {
    console.log("  GitHub knows no such account; skipped.")
    continue
  }
  const sure = await ask.question(`  Stamp ${account.email ?? account.id} as @${user.login}? [y/N] `)
  if (sure.trim() !== "y") continue
  try {
    await call("stamp", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ userId: account.id, githubId: String(user.id) }),
    })
    stamped++
    console.log("  Stamped.")
  } catch (error) {
    console.log(`  Not stamped: ${error.message}`)
  }
}
ask.close()
console.log(`\n${stamped} of ${accounts.length} stamped.`)

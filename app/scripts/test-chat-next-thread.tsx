import assert from "node:assert/strict"
import test from "node:test"
import { MemoryRouter, Route, Routes } from "react-router"

import { ChatNextPage } from "@/chat-next/page"
import { recorded } from "./chat-next-fixtures.ts"
import { find, findAll, json, mount, text } from "./component-kit.tsx"

const fixture = recorded("sky-blue.transcript.json")
const SESSION = fixture.data[0].session_id

const screen = (query: string) => (
  <MemoryRouter initialEntries={[`/next?${query}`]}>
    <Routes>
      <Route path="/next" element={<ChatNextPage />} />
    </Routes>
  </MemoryRouter>
)

test("a session opened by address draws its request, its words and its calls from the host's transcript", async () => {
  const asked: { url: URL; authorization: string | null }[] = []
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input))
    // The version check comes first and asks for no key, as Hermes's `/health` does.
    if (url.pathname === "/health")
      return json({ status: "ok", platform: "hermes-agent", version: "0.22.5" })
    // The plugin's list of children is a route this host does not have.
    if (url.pathname.startsWith("/api/plugins/")) return json({ error: {} }, 404)
    asked.push({ url, authorization: new Headers(init?.headers).get("authorization") })
    return json(fixture)
  }) as typeof fetch

  const query = `server=${encodeURIComponent("http://hermes.test")}&key=secret&session=${SESSION}`
  await mount(screen(query), async () => {
    assert.equal(asked.length, 1, "one read of the chat")
    assert.equal(asked[0].url.pathname, `/api/sessions/${SESSION}/messages`)
    assert.equal(asked[0].authorization, "Bearer secret")

    assert.match(find("[data-user]")?.textContent ?? "", /^Do these steps in order/)
    const replies = findAll("[data-text]").map((one) => one.textContent ?? "")
    assert.equal(replies.length, 2, "the two stretches of words, and nothing for the empty rows")
    assert.equal(replies[0], "I'll work through these in order.")
    assert.match(replies[1], /Why the Sky Is Blue/)
    assert.equal(find("[data-tools]")?.textContent, "8 tool calls")
    assert.ok(!text().includes("hello from fixture\\n"), "a call's result is not drawn yet")
  })
})

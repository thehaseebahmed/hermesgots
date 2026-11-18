/**
 * The phone's message: what Firebase is asked to carry for an Android install (G5, G8).
 *
 * A `notification` payload is drawn by Android itself, and Android's own drawing has no room for a
 * button — so the message is data-only and the app's `GotsMessagingService` draws it: the notice's
 * title and body, the badged picture, the category's channel and the same tag a newer notice of the
 * same thing replaces, and the two links an approval carries. Everything a data message carries is
 * a string, so the buttons ride as JSON.
 *
 * The registry's half is driven through its own handler, since it is the one that bounds what a
 * plugin sends: a picture and two links are forwarded, and anything that isn't one is dropped.
 */
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import test from "node:test"

import { message } from "../netlify/lib/fcm.ts"
import { handleRegistry, sha256 } from "../netlify/lib/registry.ts"
import { memoryStore } from "./netlify-store.mjs"

const ONCE = "https://bot.example/api/plugins/gots/push/answer/once-1"
const DENY = "https://bot.example/api/plugins/gots/push/answer/deny-1"
const ICON = "https://hermesgots.dev/bots/nova/notify.png"

/** An approval's notice as the plugin relays it: the chat's name, the card's body, the two links. */
const approval = {
  title: "Fix the build",
  body: "Clear the build\n\nrm -rf ./build",
  bot: "nova",
  icon: ICON,
  actions: [
    { label: "Allow once", url: ONCE },
    { label: "Deny", url: DENY },
  ],
}

const NOW = Date.UTC(2026, 10, 17, 9)
const USER_ID = "u1"
const TOKEN = "mh_push_message_test"
const HOST_ID = "3f1c2a4e-5b6d-4e7f-8a9b-0c1d2e3f4a5b"
const KEY_ID = "0123456789abcdef"

/** A sender that keeps what the registry told it, so the detail it was handed is what is read. */
function sender() {
  const sent = []
  return {
    sent,
    async send(token, kind, category, sessionId, detail) {
      sent.push({ token, kind, category, sessionId, detail })
      return "ok"
    },
    async test() {
      return null
    },
  }
}

/** A store holding this site's one linked host, one bot and one registered Android install. */
async function setup() {
  const store = memoryStore()
  const tokenHash = await sha256(TOKEN)
  store.data.set(`tokens/${tokenHash}`, { userId: USER_ID, hostId: HOST_ID })
  store.data.set(`users/${USER_ID}/hosts/${HOST_ID}`, { tokenHash, createdAt: NOW })
  store.data.set(`users/${USER_ID}/bots/nova`, {
    hostId: HOST_ID,
    keyId: KEY_ID,
    sealed: { v: 1, epk: "ZXBr", iv: "aXY=", ct: "Y3Q=" },
    enabled: true,
    createdAt: NOW,
    updatedAt: NOW,
  })
  store.data.set(`users/${USER_ID}/devices/d1`, { token: "fcm-token-d1", updatedAt: NOW })
  return store
}

/** One `POST push` from the plugin, answering what the route said and what Firebase was handed. */
async function relay(store, body) {
  const fcm = sender()
  const url = new URL("https://x.test/api")
  url.searchParams.set("route", "push")
  const res = await handleRegistry(
    new Request(url, { method: "POST", body: JSON.stringify(body) }),
    {
      store,
      caller: { kind: "host", token: TOKEN },
      inbox: async () => ({ keyId: KEY_ID, publicKey: "-----BEGIN PUBLIC KEY-----\nnot read here\n" }),
      origins: ["https://hermesgots.dev"],
      fcm,
      now: NOW,
    },
  )
  return { status: res.status, detail: fcm.sent[0]?.detail }
}

test("the message is data-only: nothing is left for Android to draw", () => {
  const sent = message("fcm-token-d1", "approval", "chat_input", "gots-1", approval)
  assert.equal(
    "notification" in sent.message,
    false,
    "a notification payload is Android's to draw, and Android's drawing can carry no button",
  )
  assert.equal(sent.message.token, "fcm-token-d1")
  assert.deepEqual(
    sent.message.android,
    { priority: "HIGH", ttl: "600s" },
    "it is still urgent, and still lets go of stale news after ten minutes",
  )
})

test("the body a plugin sent is what the phone shows, over the table's line", () => {
  const { data } = message("t", "approval", "chat_input", "gots-1", approval).message
  assert.equal(data.title, "Fix the build", "the chat's name")
  assert.equal(data.body, approval.body, "and the card's own body under it")
  assert.equal(data.kind, "approval")
  assert.equal(data.session_id, "gots-1")
  // Firebase takes a data value as a string and nothing else: a number here is a rejected message.
  for (const [key, value] of Object.entries(data)) {
    assert.equal(typeof value, "string", `the data's ${key} is a string`)
  }
})

test("the badged picture and both links ride in the message", () => {
  const { data } = message("t", "approval", "chat_input", "gots-1", approval).message
  assert.equal(data.icon, ICON, "the one image web push, ntfy and Android all wear")
  assert.equal(data.bot, "nova", "so a phone that can't fetch it falls back to the badge it ships")
  assert.deepEqual(
    JSON.parse(data.actions),
    [
      { label: "Allow once", url: ONCE },
      { label: "Deny", url: DENY },
    ],
    "both buttons, in the order the notice carries them",
  )
  assert.equal(data.channel, "chat_input", "the channel the app makes for this category")
  assert.equal(data.tag, "chat_input:gots-1", "and the tag a newer one about the same thing replaces")
  assert.equal(data.category, "chat_input")
})

test("a plugin that names no words still says the table's line", () => {
  const { data } = message("t", "run_done", "chat_run_done", "gots-2").message
  assert.equal(data.title, "Gots", "a title nothing named")
  assert.equal(data.body, "You have a new reply", "and the kind's own line")
  assert.equal(data.actions, undefined, "a finished run carries no button")
  assert.equal(data.icon, undefined, "and no picture it wasn't given")
  assert.equal(data.channel, "chat_run_done")
  // The test notification is the one kind with a channel of its own, made on the tap that sends one.
  assert.equal(message("t", "test", "test", "").message.data.channel, "test_notification")
})

test("the registry hands Firebase the notice's words, its picture and its two links", async () => {
  const { status, detail } = await relay(await setup(), {
    kind: "approval",
    category: "chat_input",
    session_id: "gots-1",
    ...approval,
  })
  assert.equal(status, 200)
  assert.deepEqual(
    detail,
    {
      title: "Fix the build",
      body: approval.body,
      bot: "nova",
      icon: ICON,
      actions: [
        { label: "Allow once", url: ONCE },
        { label: "Deny", url: DENY },
      ],
    },
    "the detail carries what a phone draws, and nothing it can't",
  )
})

test("the registry bounds a notice and drops what isn't a picture or a link", async () => {
  const { detail } = await relay(await setup(), {
    kind: "approval",
    category: "chat_input",
    session_id: "gots-1",
    title: `  ${"t".repeat(200)}  `,
    body: "b".repeat(1200),
    bot: "nova",
    icon: "javascript:alert(1)",
    actions: [
      { label: "Allow once", url: ONCE },
      { label: "Open a page", url: "file:///etc/passwd" },
      { label: "Deny", url: DENY },
      { label: "A third", url: "https://bot.example/third" },
      { label: "   ", url: "https://bot.example/blank" },
      "not an action",
    ],
  })
  assert.equal(detail.title.length, 120, "a title is cut at the length a tray shows")
  assert.equal(
    detail.body.length,
    800,
    "and a body is cut at the longest one the plugin sends — an approval's command",
  )
  assert.equal(detail.icon, undefined, "a picture is an http(s) address or it is nothing")
  assert.deepEqual(
    detail.actions,
    [
      { label: "Allow once", url: ONCE },
      { label: "Deny", url: DENY },
    ],
    "at most two, each a label and an http(s) link, in the order they were sent",
  )
})

test("the dev mock answers a tray's button the way the plugin does", () => {
  // AGENTS.md requires the mock to serve what the app calls, and this one route no browser flow can
  // reach: nothing in the mock sends a push, so a press is driven from the source it serves. The
  // words are held to the plugin's own, since a reader shown a different sentence than the host says
  // would be reading a screen this app never shows.
  const mock = readFileSync(new URL("./mock-hermes.mjs", import.meta.url), "utf8")
  const plugin = readFileSync(new URL("../../plugin/__init__.py", import.meta.url), "utf8")
  assert.ok(
    mock.includes(String.raw`/^\/api\/plugins\/gots\/push\/answer\/([^/]+)$/`),
    "the mock matches the link an approval's button posts to, and nothing else",
  )
  for (const said of [
    "That button isn't one this bot sent.",
    "That button has already been answered.",
  ]) {
    assert.ok(plugin.includes(said), `the plugin answers a press with "${said}"`)
    assert.ok(mock.includes(said), `and the mock answers it the same way, not in words of its own`)
  }
  assert.match(
    mock,
    /object: "gots\.push\.answer",\s*\n\s*answered: true,\s*\n\s*choice: held\.choice/,
    "a press that settles answers as the plugin's route does: the choice the row held",
  )
  assert.match(
    mock,
    /const resolve = pendingApprovals\.get\(held\.runId\)/,
    "and it settles the run that minted the token, as `answers.answer_run` settles one through Hermes's queue",
  )
})

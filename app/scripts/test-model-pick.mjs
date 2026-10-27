/**
 * A chat's model, and the one its first send fixes there: changing a bot's Default model says what
 * the turns to come run on, and must leave the threads and sessions already running alone. The rule
 * is held here on its own, with no database and no host.
 */
import assert from "node:assert/strict"
import test from "node:test"

import { modelOf, pickOf, pinOf, storedPick, wantsPin } from "../src/lib/model-pick.ts"

const sonnet = { provider: "anthropic", model: "claude-sonnet-4.5" }
const gpt = { provider: "openai", model: "gpt-5" }

/** A bot as Settings leaves it: a default model of its own, or none and the host's model runs. */
const bot = (modelChoice) => ({ model: "test/model", modelChoice })
/** The bot's default alone, as the pick readers take it: no name of the bot's own is read. */
const defaultOf = (modelChoice) => ({ modelChoice })
const chat = (extra = {}) => ({ id: "c1", profileId: "bot-1", ...extra })

test("a chat with no pick of its own runs the bot's default", () => {
  assert.deepEqual(modelOf(chat(), bot(sonnet)), sonnet)
  assert.deepEqual(pickOf(chat(), defaultOf(sonnet)), sonnet)
})

test("the first send pins the default, so the chat keeps it once the default moves on", () => {
  const first = chat()
  const pin = pinOf(first, sonnet)
  assert.deepEqual(pin, sonnet, "the model the turn would have run on")
  const pinned = { ...first, modelChoice: pin }
  assert.deepEqual(modelOf(pinned, bot(gpt)), sonnet, "the chat's own model, not the new default")
  assert.equal(pinOf(pinned, gpt), undefined, "a chat already settled pins nothing further")
  assert.equal(wantsPin(pinned), false, "and it has no reason to ask the host either")
})

test("Main never pins: its whole job is to follow the default as it changes", () => {
  const main = chat({ main: true })
  assert.equal(pinOf(main, sonnet), undefined)
  assert.equal(wantsPin(main), false, "so Main never asks the host for one")
  assert.deepEqual(modelOf(main, bot(sonnet)), sonnet)
  assert.deepEqual(modelOf(main, bot(gpt)), gpt, "the next default is Main's next model")
})

test("a chat with a pick of its own is untouched by a default change", () => {
  const picked = chat({ modelChoice: gpt })
  assert.equal(pinOf(picked, sonnet), undefined)
  assert.deepEqual(modelOf(picked, bot(sonnet)), gpt)
})

test("a chat pins the pick its caller resolved, the host's model included", () => {
  // The caller resolves what the screen shows — the bot's default, else the host's own — and
  // the rule pins that, so a chat can't show one model and pin nothing.
  assert.deepEqual(pinOf(chat(), { provider: "llama", model: "local/llama" }), {
    provider: "llama",
    model: "local/llama",
  })
})

test("a pick nothing could send is no pin", () => {
  // `runRequest` sends neither `model` nor `provider` without a provider, and the plugin's
  // `chats.choice` reads a half pick as none: a pin with an empty provider is inert everywhere, so
  // the chat follows the default rather than holding a pick nothing honours.
  assert.equal(pinOf(chat(), { provider: "", model: "local/llama" }), undefined)
  assert.equal(pinOf(chat(), { model: "local/llama" }), undefined)
  // Hermes reads provider `auto` as whichever credentials fit, so a pin naming it pins no model.
  assert.equal(pinOf(chat(), { provider: "auto", model: "local/llama" }), undefined)
})

test("a chat told to follow the default keeps that after a send", () => {
  // The Default row is a choice, written on the row as a pick with no model in it: its presence
  // says the user has chosen, so the next send pins nothing over it.
  const following = chat({ modelChoice: storedPick(undefined) })
  assert.equal(wantsPin(following), false, "so the host isn't asked for one")
  assert.equal(pinOf(following, gpt), undefined, "Default survives the send")
  assert.deepEqual(modelOf(following, bot(gpt)), gpt, "and the chat runs the default it follows")
  assert.deepEqual(modelOf(following, bot(sonnet)), sonnet, "as the default moves on")
})

test("with no model from the host there's nothing to pin, and the chat still wants one", () => {
  assert.equal(pinOf(chat(), undefined), undefined)
  assert.equal(wantsPin(chat()), true, "the one case where the host is asked for a model")
  assert.deepEqual(modelOf(chat(), bot(undefined)), { model: "test/model", provider: undefined })
})

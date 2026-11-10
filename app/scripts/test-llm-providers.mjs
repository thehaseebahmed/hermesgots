/**
 * What the LLM Providers page will send, as a rule: a key form's Save is dead until the field holds
 * something a key could be. An empty field has nothing to write, and a mask — the `***` a short key
 * masks as, a first-four/last-four elision, or a `«redacted…»` sentinel — is what the page was handed
 * rather than a key, so it is never submitted back. The host refuses a mask on its own rule too; this
 * is the screen's half of the same fact, so no tap can even ask.
 */
import assert from "node:assert/strict"
import test from "node:test"

import {
  customEndpointId,
  customTarget,
  endpointRows,
  providerRows,
  submittableEndpoint,
  submittableKey,
} from "../src/lib/llm-providers.ts"

test("an empty field, or one holding only spaces, has nothing to send", () => {
  assert.equal(submittableKey(""), false)
  assert.equal(submittableKey("   "), false)
  assert.equal(submittableKey("\n\t "), false)
})

test("a mask is never a key to send", () => {
  assert.equal(submittableKey("***"), false, "what `mask_secret` makes of a short key")
  assert.equal(submittableKey("sk-o...c123"), false, "a first-four, last-four elision")
  assert.equal(
    submittableKey("«redacted:sk-o...c123»"),
    false,
    "the sentinel a Dashboard copy carries",
  )
})

test("a mask of any shape is never a key to send", () => {
  // A mask is a mask whatever its ends are and whatever cut it: refusing only a four-and-four
  // elision let `sk-abcd...123456` through, and a copy's own ellipsis or a redaction marker through
  // with it.
  const shapes = [
    ["sk-abcd...123456", "a dotted elision with any length at either end"],
    ["sk-o…c123", "the single-character ellipsis a copy carries"],
    ["«redacted", "the sentinel with its closing » lost"],
    ["[redacted]", "a redaction marker"],
    ["sk-o ... c123", "dots with a space either side"],
  ]
  for (const [shape, why] of shapes) assert.equal(submittableKey(shape), false, why)
})

test("the mask the row drew is refused by its own string, whatever shape it has", () => {
  // The row hands the page its `masked`: a shape a later host invents is still the string on screen,
  // and it is the string that decides rather than this build's list of shapes.
  assert.equal(submittableKey("opaque-mask-7f3a", "opaque-mask-7f3a"), false)
  assert.equal(submittableKey("opaque-mask-7f3a"), true, "without the row's mask it is just a key")
  assert.equal(
    submittableKey("typed-key-0000-abcd", "opaque-mask-7f3a"),
    true,
    "and another row's mask is another string",
  )
})

test("something typed is a key, whatever surrounds it", () => {
  assert.equal(submittableKey("new-key-0000-zyxw"), true)
  assert.equal(
    submittableKey("  new-key-0000-zyxw  "),
    true,
    "the field's own spaces are not part of the key",
  )
})

test("an endpoint's row is its name, the URL and model it runs, and its mask", () => {
  const rows = endpointRows({
    providers: [],
    endpoints: [
      {
        id: "local-llama",
        name: "Local Llama",
        base_url: "http://127.0.0.1:8080/v1",
        model: "llama-3.1-8b",
        masked: "llam...0a1f",
      },
      {
        id: "bare",
        name: "Bare",
        base_url: "https://bare.example.com/v1",
        model: "bare-1",
        masked: null,
      },
    ],
  })
  assert.deepEqual(
    rows[0],
    {
      target: "custom:local-llama",
      title: "Local Llama",
      purpose: "http://127.0.0.1:8080/v1 · llama-3.1-8b",
      value: "llam...0a1f",
    },
    "the name, the base URL and model on one line, the mask as the value, and its address",
  )
  assert.equal(rows[1].value, "", "an endpoint with no key draws as Not set")
  assert.equal(rows[1].purpose, "https://bare.example.com/v1 · bare-1")
})

test("both lists are one row: an address, a title, the line under it, and the mask", () => {
  // The two kinds of key differ in what its address is and what its line says, not in the shape a row
  // has — so the page draws either list with one row, and neither can grow a field the other lacks.
  const block = {
    providers: [
      { slug: "openai", label: "OpenAI", description: "GPT models.", masked: "sk-o...c123" },
    ],
    endpoints: [
      {
        id: "local-llama",
        name: "Local Llama",
        base_url: "http://127.0.0.1:8080/v1",
        model: "llama-3.1-8b",
        masked: null,
      },
    ],
  }
  const [provider] = providerRows(block)
  const [endpoint] = endpointRows(block)
  assert.deepEqual(
    Object.keys(provider).sort(),
    Object.keys(endpoint).sort(),
    "one shape for a provider's row and an endpoint's",
  )
  assert.deepEqual(
    provider,
    {
      target: "openai",
      title: "OpenAI",
      purpose: "GPT models.",
      value: "sk-o...c123",
    },
    "a provider's row: its slug as the address, its label, the host's line, and its mask",
  )
})

test("a key's address is one target: custom:<id> for an endpoint, a slug for a provider", () => {
  assert.equal(customTarget("local-llama"), "custom:local-llama")
  assert.equal(customEndpointId("custom:local-llama"), "local-llama")
  assert.equal(customEndpointId("openai"), "", "a provider's slug names no endpoint")
  assert.equal(customEndpointId(""), "")
})

test("a new endpoint is only worth saving once it holds all four of its fields", () => {
  const whole = {
    name: "Home box",
    base_url: "http://10.0.0.5:8080/v1",
    model: "qwen2.5",
    key: "home-box-key-0000-abcd",
  }
  assert.equal(submittableEndpoint(whole), true, "a name, a URL, a model and a typed key")

  // Each of the three is this page's own text, and a field holding only spaces says nothing.
  for (const field of ["name", "base_url", "model"]) {
    assert.equal(
      submittableEndpoint({ ...whole, [field]: "   " }),
      false,
      `${field} has to say something`,
    )
  }
  assert.equal(submittableEndpoint({ ...whole, key: "" }), false, "and there is nothing to send")
  assert.equal(
    submittableEndpoint({ ...whole, key: "sk-o...c123" }),
    false,
    "a mask is never a key to send, however new the endpoint is",
  )
})

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
      id: "local-llama",
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

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
  editEndpointBody,
  endpointChanges,
  endpointRows,
  newEndpointBody,
  providerRows,
  readLlmProviders,
  saveableEndpointEdit,
  submittableEndpoint,
  submittableKey,
  TRANSPORTS,
  transportLabel,
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
        key_env: "HERMES_CUSTOM_LOCAL_LLAMA_API_KEY",
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

test("a transport is a name in words, and one this build can't name is still its own word", () => {
  assert.equal(transportLabel(""), "Automatic", "an endpoint that pins none is automatic")
  assert.equal(transportLabel("chat_completions"), "Chat completions")
  assert.equal(transportLabel("codex_responses"), "Responses", "the host's own name for Responses")
  assert.equal(transportLabel("anthropic_messages"), "Anthropic messages")
  // A string a later host invents is not dropped: it is drawn as it arrived and writes back whole.
  assert.equal(transportLabel("bedrock_converse"), "bedrock_converse")
  assert.deepEqual(
    TRANSPORTS.map((one) => one.label),
    ["Automatic", "Chat completions", "Responses", "Anthropic messages"],
    "the pick offers exactly these four, in this order",
  )
})

test("an endpoint's write carries the fields that differ, and nothing that doesn't", () => {
  const held = {
    name: "Local Llama",
    base_url: "http://127.0.0.1:8080/v1",
    model: "llama-3.1-8b",
    transport: "chat_completions",
    affinity: "",
  }
  assert.deepEqual(endpointChanges(held, held), {}, "a form left as it was has nothing to write")
  assert.deepEqual(
    endpointChanges(held, { ...held, model: "  llama-3.1-70b " }),
    { model: "llama-3.1-70b" },
    "a changed field is written trimmed, and the fields that didn't change are not written at all",
  )
  assert.deepEqual(
    endpointChanges(held, { ...held, transport: "", affinity: "x-litellm-session-id" }),
    { transport: "", affinity: "x-litellm-session-id" },
    "automatic is a value: clearing the transport writes the empty string rather than leaving it",
  )
  assert.deepEqual(
    endpointChanges({ ...held, affinity: "x-old" }, { ...held, affinity: "  " }),
    { affinity: "" },
    "and a header cleared is cleared, not kept for saying spaces",
  )
})

test("an endpoint's save is offered for a changed field or a typed key, and for nothing else", () => {
  const held = {
    name: "Local Llama",
    base_url: "http://127.0.0.1:8080/v1",
    model: "llama-3.1-8b",
    transport: "chat_completions",
    affinity: "",
  }
  const masked = "llam...0a1f"
  assert.equal(saveableEndpointEdit(held, held, "", masked), false, "an untouched form writes nothing")
  assert.equal(
    saveableEndpointEdit(held, { ...held, model: "llama-3.1-70b" }, "", masked),
    true,
    "a field that differs is worth writing",
  )
  assert.equal(
    saveableEndpointEdit(held, held, "endpoint-key-0000-0a1f", masked),
    true,
    "so is a key typed over the mask",
  )
  assert.equal(saveableEndpointEdit(held, held, masked, masked), false, "but a mask is never one")
  assert.equal(
    saveableEndpointEdit({ ...held, affinity: "x-old" }, { ...held, affinity: "" }, "", null),
    true,
    "and clearing the last field is a change like any other",
  )
  // The host needs the three fields an endpoint is: a form that emptied one holds nothing to write,
  // however much else changed.
  for (const field of ["name", "base_url", "model"])
    assert.equal(
      saveableEndpointEdit(held, { ...held, [field]: "  " }, "", masked),
      false,
      `${field} emptied is no endpoint`,
    )
})

test("the body of a write carries the id when it edits, and the whole shape when it adds", () => {
  const held = {
    name: "Local Llama",
    base_url: "http://127.0.0.1:8080/v1",
    model: "llama-3.1-8b",
    transport: "chat_completions",
    affinity: "",
  }
  assert.deepEqual(
    editEndpointBody("local-llama", held, { ...held, model: "llama-3.1-70b" }, "", "llam...0a1f"),
    { id: "local-llama", model: "llama-3.1-70b" },
    "the id the row is, the field that changed, and no key the field didn't hold",
  )
  assert.deepEqual(
    editEndpointBody("local-llama", held, held, "endpoint-key-0000-0a1f", "llam...0a1f"),
    { id: "local-llama", key: "endpoint-key-0000-0a1f" },
    "a key alone is a body of its own, under the id it is written to",
  )
  assert.deepEqual(
    newEndpointBody({
      name: " Home box ",
      base_url: " http://10.0.0.5:8080/v1 ",
      model: " qwen2.5 ",
      key: " home-box-key-0000-abcd ",
    }),
    {
      name: "Home box",
      base_url: "http://10.0.0.5:8080/v1",
      model: "qwen2.5",
      key: "home-box-key-0000-abcd",
    },
    "a new endpoint sends the four fields it holds and nothing it doesn't",
  )
  assert.deepEqual(
    newEndpointBody({
      name: "Home box",
      base_url: "http://10.0.0.5:8080/v1",
      model: "qwen2.5",
      key: "home-box-key-0000-abcd",
      transport: "anthropic_messages",
      affinity: "x-litellm-session-id",
    }),
    {
      name: "Home box",
      base_url: "http://10.0.0.5:8080/v1",
      model: "qwen2.5",
      transport: "anthropic_messages",
      affinity: "x-litellm-session-id",
      key: "home-box-key-0000-abcd",
    },
    "and the two settings the form was given when it was given them",
  )
})

test("an endpoint read carries its transport and its affinity header", () => {
  const block = readLlmProviders({
    providers: [],
    endpoints: [
      {
        id: "local-llama",
        name: "Local Llama",
        base_url: "http://127.0.0.1:8080/v1",
        model: "llama-3.1-8b",
        transport: "chat_completions",
        affinity: "x-litellm-session-id",
        key_env: "HERMES_CUSTOM_LOCAL_LLAMA_API_KEY",
        masked: "llam...0a1f",
      },
      { id: "bare", name: "Bare", base_url: "https://bare.example.com/v1", model: "bare-1" },
    ],
  })
  assert.deepEqual(block.endpoints[0], {
    id: "local-llama",
    name: "Local Llama",
    base_url: "http://127.0.0.1:8080/v1",
    model: "llama-3.1-8b",
    transport: "chat_completions",
    affinity: "x-litellm-session-id",
    key_env: "HERMES_CUSTOM_LOCAL_LLAMA_API_KEY",
    masked: "llam...0a1f",
  })
  // An answer from a host that names neither reads as an endpoint that pins nothing and carries no
  // header: the form is filled from the row, so a missing field must not fill it with a guess.
  assert.equal(block.endpoints[1].transport, "")
  assert.equal(block.endpoints[1].affinity, "")
  assert.equal(block.endpoints[1].key_env, "", "a host that names no variable leaves the label blank")
  assert.equal(block.endpoints[1].masked, null)
})

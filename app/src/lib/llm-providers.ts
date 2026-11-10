/**
 * A bot's LLM providers, as its Hermes answers them (`plugin/llm_providers.py`): the API-key
 * providers the host's own catalog knows, and the custom OpenAI-compatible endpoints it holds. A
 * key reaches this file only as the mask the host made of it, `mask_secret`'s own output; nothing
 * here builds, derives or unwraps one, and a row's presence is that mask rather than a second flag
 * beside it.
 *
 * A key is one resource with one address whatever kind of row owns it: a provider's catalog slug, or
 * an endpoint's `custom:<id>`. `customTarget` spells the second and `customEndpointId` reads one
 * back, so the screen and the form that writes it never disagree about what a target is.
 */

/** The feature a host advertises when it can list its providers (and can withhold the page). */
export const LLM_PROVIDERS = "llm_providers"

/** One provider the host can be given a key for. */
export interface LlmProvider {
  /** The host's catalog id, which is what a key is written against. */
  slug: string
  /** The provider as a row titles it. */
  label: string
  /** The host's own line about the provider. */
  description: string
  /** The variable this key is written to — `OPENAI_API_KEY` — which the form labels its field with. */
  env: string
  /** `mask_secret`'s output — `sk-o...c123`, or `***` under its floor — or `null` where unset. */
  masked: string | null
}

/** One custom endpoint the host holds, as its own list answers it. */
export interface LlmEndpoint {
  id: string
  name: string
  base_url: string
  /** The model the endpoint runs when this bot's model names it. */
  model: string
  /**
   * The transport it pins, in the host's own spelling (`api_mode` in its `config.yaml`), or `""`
   * for Automatic — the runtime's own guess from the address, which is what a fresh endpoint does.
   */
  transport: string
  /** The header a proxy carries the conversation on (`session_affinity_header`), or `""`. */
  affinity: string
  /** The variable this endpoint's key is held in, which the form labels its field with. */
  key_env: string
  masked: string | null
}

/** The page's one block: what a read answers, and what every write answers again. */
export interface LlmProviders {
  providers: LlmProvider[]
  endpoints: LlmEndpoint[]
}

/**
 * One row the page draws, whatever kind of key it holds: the address that key is written to, the row's
 * title, the muted line under it, and the mask as the value. One shape for both lists, so the page's
 * row is drawn once — a provider's address is its catalog slug and its line the host's own
 * description, and an endpoint's address is `custom:<id>` and its line the base URL and model it runs.
 */
export interface LlmProviderRow {
  /**
   * The address its key is written to: a provider's catalog slug, or an endpoint's `custom:<id>`. One
   * address, one key, whatever kind of row owns it.
   */
  target: string
  /** The row's title: a provider's label, or an endpoint's name. */
  title: string
  /**
   * The host's muted line under the title: a provider's own description, or an endpoint's base URL and
   * model. Neither is the page's to change, so neither is the row's value.
   */
  purpose: string
  /**
   * The mask, or `""` where no key is set: an empty value is what `ValueRow` already draws as
   * *Not set*, so the page says a key is missing the way every other row says it.
   */
  value: string
}

/** The providers' rows, in the host's order: a label over its line, its mask as the value. */
export function providerRows(block: LlmProviders): LlmProviderRow[] {
  return block.providers.map((provider) => ({
    target: provider.slug,
    title: provider.label,
    purpose: provider.description,
    value: provider.masked ?? "",
  }))
}

/** The prefix one address spells an endpoint's key with, so no slug can be mistaken for an id. */
const CUSTOM_TARGET = "custom:"

/** The address one endpoint's key is written to: `custom:<id>`. */
export function customTarget(id: string): string {
  return `${CUSTOM_TARGET}${id}`
}

/** The endpoint an address names, or `""` for a target that names a provider instead. */
export function customEndpointId(target: string): string {
  return target.startsWith(CUSTOM_TARGET) ? target.slice(CUSTOM_TARGET.length) : ""
}

/**
 * The variable Hermes names a custom endpoint's key by, from the name typed for it:
 * `HERMES_CUSTOM_HOME_BOX_API_KEY`. It mirrors the host's own `custom_endpoint_key_env`, so the add
 * form can label its key field with the name the key will actually live under.
 */
export function customKeyEnv(name: string): string {
  const slug = name
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
  return `HERMES_CUSTOM_${slug || "ENDPOINT"}_API_KEY`
}

/**
 * The endpoints' rows, in the host's order: the endpoint's name, the base URL and model it runs on
 * one line, and its mask as the value — the same row a provider draws, under the address its key is
 * written to.
 */
export function endpointRows(block: LlmProviders): LlmProviderRow[] {
  return block.endpoints.map((endpoint) => ({
    target: customTarget(endpoint.id),
    title: endpoint.name,
    purpose: [endpoint.base_url, endpoint.model].filter(Boolean).join(" · "),
    value: endpoint.masked ?? "",
  }))
}

/**
 * The shapes a mask arrives in, as the page must never send one back: `mask_secret`'s `***`, a
 * dotted elision whose ends are any length at all, the single-character ellipsis a copied preview
 * carries, the `«redacted…»` sentinel a Dashboard copy sends (with or without its closing `»`), and
 * a `[redacted]` marker. The host refuses a mask on its own rule; this is the screen's half, so no
 * Save is even offered.
 */
const MASK_SHAPES = [/^\*{3,}$/, /\.{2,}/, /\u2026/, /^«redacted/, /\[redacted\]/i]

/**
 * Whether a key form holds something worth submitting: a typed key, and never a mask. A field left
 * empty (or holding only spaces) has nothing to write, and the mask the page drew is the host's
 * string rather than a key — sending it back would be a write of nothing at all.
 *
 * `masked` is the `masked` the row handed this page, compared as the string it is: the shapes above
 * are the host's spellings this build remembers, and a mask shape a later host invents is still the
 * exact string on screen, so the field refuses it too.
 */
export function submittableKey(value: string, masked?: string | null): boolean {
  const key = value.trim()
  if (!key) return false
  if (masked && key === masked.trim()) return false
  return !MASK_SHAPES.some((shape) => shape.test(key))
}

/**
 * The transports a custom endpoint can pin, in the host's own spellings: `api_mode` in its
 * `config.yaml`, the value `hermes model` writes and the runtime reads. `""` is Automatic — no pin
 * at all, the runtime guessing from the address — and is drawn as its own choice rather than a
 * missing one, since an endpoint with a hand-written `api_mode` is the exception.
 */
export const TRANSPORTS: { value: string; label: string }[] = [
  { value: "", label: "Automatic" },
  { value: "chat_completions", label: "Chat completions" },
  { value: "codex_responses", label: "Responses" },
  { value: "anthropic_messages", label: "Anthropic messages" },
]

/**
 * A transport as the pick and the row say it. A spelling this build doesn't know is drawn as it
 * arrived rather than dropped or rounded to Automatic: a value the host pinned is the host's fact,
 * and the form must write it back exactly as it read it.
 */
export function transportLabel(value: string): string {
  return TRANSPORTS.find((one) => one.value === value)?.label ?? value
}

/**
 * The fields an endpoint's form holds, as one object: everything the host keeps for the endpoint
 * that this page can change. The key is not one of them — it is typed, never drawn — and the id is
 * the address the write names rather than a field.
 */
export interface LlmEndpointFields {
  name: string
  base_url: string
  model: string
  transport: string
  affinity: string
}

/** The fields a row hands its form, as the form starts: the host's own values, untouched. */
export function endpointFieldsOf(endpoint: LlmEndpoint): LlmEndpointFields {
  return {
    name: endpoint.name,
    base_url: endpoint.base_url,
    model: endpoint.model,
    transport: endpoint.transport,
    affinity: endpoint.affinity,
  }
}

/** The fields, in the order the form draws them, so a change is found the same way every time. */
const ENDPOINT_FIELDS = ["name", "base_url", "model", "transport", "affinity"] as const

/**
 * What an endpoint's save writes: each field whose value differs from the row's, trimmed, and no
 * field that doesn't. A field emptied is a change like any other and is written as `""` — for the
 * transport that is Automatic, and for the header that is none — so a setting a user clears is
 * cleared on the host rather than left behind by an omission.
 */
export function endpointChanges(
  held: LlmEndpointFields,
  draft: LlmEndpointFields,
): Partial<LlmEndpointFields> {
  const changes: Partial<LlmEndpointFields> = {}
  for (const field of ENDPOINT_FIELDS) {
    const value = draft[field].trim()
    if (value !== held[field].trim()) changes[field] = value
  }
  return changes
}

/**
 * Whether an endpoint's form holds something worth writing: a typed key, or a field that differs
 * from the row it opened with. A form that emptied one of the three fields an endpoint is has
 * nothing to write whatever else changed — the host needs a name, a base URL and a model — and a
 * mask in the key field is never a key (`submittableKey`).
 */
export function saveableEndpointEdit(
  held: LlmEndpointFields,
  draft: LlmEndpointFields,
  key: string,
  masked?: string | null,
): boolean {
  const whole = Boolean(draft.name.trim() && draft.base_url.trim() && draft.model.trim())
  if (!whole) return false
  return Object.keys(endpointChanges(held, draft)).length > 0 || submittableKey(key, masked)
}

/** The body one endpoint write carries: the fields a caller set, and nothing it left out. */
export interface LlmEndpointBody extends Partial<LlmEndpointFields> {
  /** The id the write patches; left off a write that adds an endpoint. */
  id?: string
  /** The key typed into the form, and never a mask, and never anything a form left empty. */
  key?: string
}

/**
 * The body an endpoint's edit posts: the id of the row it edits, the fields that differ, and the
 * key only where one was typed over the mask — so a save that touched nothing but the model never
 * carries a credential, and a save that touched nothing but the key never rewrites a setting with
 * a value the form happened to send back.
 */
export function editEndpointBody(
  id: string,
  held: LlmEndpointFields,
  draft: LlmEndpointFields,
  key: string,
  masked?: string | null,
): LlmEndpointBody {
  const body: LlmEndpointBody = { id, ...endpointChanges(held, draft) }
  if (submittableKey(key, masked)) body.key = key.trim()
  return body
}

/**
 * The four fields the add form holds, as the page sends them: the name the host slugs an id from,
 * the base URL and model the endpoint runs, and the key typed into the form — plus the two settings
 * where the form was given them.
 */
export interface LlmEndpointDraft {
  name: string
  base_url: string
  model: string
  key: string
  transport?: string
  affinity?: string
}

/**
 * The body that adds an endpoint: its three required fields, the key, and the transport and header
 * only where the form was given one. An untouched Automatic and an empty header are nothing typed,
 * so they ride no further than the form — the host's own defaults then apply.
 */
export function newEndpointBody(draft: LlmEndpointDraft): LlmEndpointBody {
  return {
    name: draft.name.trim(),
    base_url: draft.base_url.trim(),
    model: draft.model.trim(),
    ...(draft.transport ? { transport: draft.transport } : {}),
    ...(draft.affinity?.trim() ? { affinity: draft.affinity.trim() } : {}),
    key: draft.key.trim(),
  }
}

/**
 * Whether the add form holds a whole endpoint: a name, a base URL, a model, and a key worth
 * submitting. Every field but the key is this page's own text and has to say something; the key is
 * `submittableKey`'s, so a mask can never be sent back as one. Nothing here checks the URL's shape —
 * the host validates that itself, and its refusal is the sentence the user reads.
 */
export function submittableEndpoint(draft: LlmEndpointDraft): boolean {
  const named = Boolean(draft.name.trim() && draft.base_url.trim() && draft.model.trim())
  return named && submittableKey(draft.key)
}

/**
 * The block a host answered, read forgivingly: a row that names no provider is dropped rather than
 * drawn blank, and an answer that isn't the block is no block at all — so a host that answered 501
 * or a shape this build doesn't know draws no page over nothing.
 */
export function readLlmProviders(raw: unknown): LlmProviders | undefined {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined
  const block = raw as Record<string, unknown>
  if (!Array.isArray(block.providers)) return undefined
  return {
    providers: block.providers.flatMap(providerOf),
    endpoints: Array.isArray(block.endpoints) ? block.endpoints.flatMap(endpointOf) : [],
  }
}

function providerOf(raw: unknown): LlmProvider[] {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return []
  const row = raw as Record<string, unknown>
  if (typeof row.slug !== "string" || !row.slug) return []
  return [
    {
      slug: row.slug,
      label: typeof row.label === "string" && row.label ? row.label : row.slug,
      description: typeof row.description === "string" ? row.description : "",
      // The variable the key is written to, as the host names it; a host that named none leaves the
      // form's label blank rather than inventing one.
      env: typeof row.env === "string" ? row.env : "",
      // The mask as it arrived, or nothing: a host that sent no string has no key to show.
      masked: typeof row.masked === "string" && row.masked ? row.masked : null,
    },
  ]
}

function endpointOf(raw: unknown): LlmEndpoint[] {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return []
  const row = raw as Record<string, unknown>
  if (typeof row.id !== "string" || !row.id) return []
  return [
    {
      id: row.id,
      name: typeof row.name === "string" && row.name ? row.name : row.id,
      base_url: typeof row.base_url === "string" ? row.base_url : "",
      model: typeof row.model === "string" ? row.model : "",
      // A host that names neither pins nothing and carries no header: the form is filled from what
      // the row says, so a silence becomes the host's own default rather than a guess at one.
      transport: typeof row.transport === "string" ? row.transport : "",
      affinity: typeof row.affinity === "string" ? row.affinity : "",
      key_env: typeof row.key_env === "string" ? row.key_env : "",
      masked: typeof row.masked === "string" && row.masked ? row.masked : null,
    },
  ]
}

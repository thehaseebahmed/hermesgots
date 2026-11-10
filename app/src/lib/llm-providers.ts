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
  masked: string | null
}

/** The page's one block: what a read answers, and what every write answers again. */
export interface LlmProviders {
  providers: LlmProvider[]
  endpoints: LlmEndpoint[]
}

/** One provider's row: its label, the host's line about it, and the mask as the value. */
export interface LlmProviderRow {
  slug: string
  title: string
  description: string
  /**
   * The mask, or `""` where no key is set: an empty value is what `ValueRow` already draws as
   * *Not set*, so the page says a key is missing the way every other row says it.
   */
  value: string
}

/** The providers' rows, in the host's order: a label over its line, its mask as the value. */
export function providerRows(block: LlmProviders): LlmProviderRow[] {
  return block.providers.map((provider) => ({
    slug: provider.slug,
    title: provider.label,
    description: provider.description,
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

/** One endpoint's row: its name, the URL and model it runs, and its mask as the value. */
export interface LlmEndpointRow {
  id: string
  /** The address its key is written to, `custom:<id>`. */
  target: string
  title: string
  purpose: string
  /** The mask, or `""` where no key is set — which `ValueRow` draws as *Not set*. */
  value: string
}

/**
 * The endpoints' rows, in the host's order: the endpoint's name, the base URL and model it runs on
 * one line, and its mask as the value. Neither the URL nor the model is the page's to change, so
 * they are the row's line rather than its value.
 */
export function endpointRows(block: LlmProviders): LlmEndpointRow[] {
  return block.endpoints.map((endpoint) => ({
    id: endpoint.id,
    target: customTarget(endpoint.id),
    title: endpoint.name,
    purpose: [endpoint.base_url, endpoint.model].filter(Boolean).join(" · "),
    value: endpoint.masked ?? "",
  }))
}

/**
 * The shapes a mask arrives in, as the page must never send one back: `mask_secret`'s `***`, its
 * first-four/last-four elision, and the `«redacted…»` sentinel a Dashboard copy carries. The host
 * refuses a mask on its own (longer) rule; this is the screen's half, so no Save is even offered.
 */
const MASKED_KEY = /^(?:\*{3,}|«redacted[^»]*»|\S{0,4}\.{3}\S{0,4})$/

/**
 * Whether a key form holds something worth submitting: a typed key, and never a mask. A field left
 * empty (or holding only spaces) has nothing to write, and the mask the page drew is the host's
 * string rather than a key — sending it back would be a write of nothing at all.
 */
export function submittableKey(value: string): boolean {
  const key = value.trim()
  return Boolean(key) && !MASKED_KEY.test(key)
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
      masked: typeof row.masked === "string" && row.masked ? row.masked : null,
    },
  ]
}

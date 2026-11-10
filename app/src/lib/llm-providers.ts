/**
 * A bot's LLM providers, as its Hermes answers them (`plugin/llm_providers.py`): the API-key
 * providers the host's own catalog knows, and — from the step that writes them — the custom
 * OpenAI-compatible endpoints it holds. A provider's key reaches this file only as the mask the
 * host made of it, `mask_secret`'s own output; nothing here builds, derives or unwraps one, and a
 * row's presence is that mask rather than a second flag beside it.
 *
 * `endpoints` is on the type from the first release and empty until the endpoints arrive, so the
 * app's shape does not change when they do.
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

/** One custom endpoint the host holds. Empty until the endpoints' step; the type is the block's. */
export interface LlmEndpoint {
  id: string
  name: string
  base_url: string
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
      masked: typeof row.masked === "string" && row.masked ? row.masked : null,
    },
  ]
}

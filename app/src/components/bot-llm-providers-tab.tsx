import { useEffect, useState } from "react"

import { Banner } from "@/components/banner"
import { Caption, Group, ValueRow } from "@/components/settings-chrome"
import { Spinner } from "@/components/ui/spinner"
import { connectionKey } from "@/lib/connection"
import type { Profile } from "@/lib/db"
import { READ_TIMEOUT_MS } from "@/lib/freshness"
import { getLlmProviders } from "@/lib/hermes"
import { providerRows, type LlmProviders } from "@/lib/llm-providers"

/**
 * The LLM Providers page: the API-key providers this bot's Hermes knows, one row each, its key drawn
 * as the mask the host made of it (`llm_providers.py`). The key itself never leaves the host, so
 * nothing here derives, reveals or compares one — a row's value is the string that arrived, and an
 * empty one is the *Not set* `ValueRow` already draws.
 *
 * The page is only ever reached where the host advertises `llm_providers` (the gate is the route's
 * own, `bot-settings.tsx`'s `PAGE_META`), so a host that can't list them draws no page at all. The
 * custom endpoints and the rows' slot screens are later steps: every row here opens nothing yet.
 */
export function LlmProvidersTab({ profile }: { profile: Profile }) {
  const [block, setBlock] = useState<LlmProviders>()
  const [problem, setProblem] = useState<string>()
  const connection = connectionKey(profile)

  useEffect(() => {
    let cancelled = false
    // The block a page draws belongs to the read that answered it: a page asked again draws nothing
    // until its own answer lands, so a failure never stands over the rows of the answer before it.
    setBlock(undefined)
    void getLlmProviders(profile, AbortSignal.timeout(READ_TIMEOUT_MS))
      .then((next) => {
        if (cancelled) return
        setProblem(next ? undefined : "This host doesn't list its LLM providers.")
        if (next) setBlock(next)
      })
      .catch((error: unknown) => {
        if (cancelled) return
        // A read that failed is still an answer: the page says what the host said.
        setProblem(
          error instanceof Error ? error.message : "Couldn't read this bot's LLM providers.",
        )
      })
    return () => {
      cancelled = true
    }
    // The connection is what the answer belongs to: another bot's read is not this page's.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [profile.id, connection])

  if (!block)
    return problem ? (
      <Banner tone="warning">{problem}</Banner>
    ) : (
      <div className="flex items-center justify-center py-16" data-llm-providers-loading>
        <Spinner />
      </div>
    )

  const rows = providerRows(block)
  return (
    <div className="flex flex-col gap-4" data-bot-llm-providers>
      {problem && <Banner tone="warning">{problem}</Banner>}
      <Caption>Providers</Caption>
      {rows.length ? (
        <Group>
          {rows.map((row) => (
            <ValueRow
              key={row.slug}
              title={row.title}
              purpose={row.description || undefined}
              // The mask, or nothing: `ValueRow` draws an empty value as *Not set*, which is the
              // truth about a provider with no key — there is no separate flag to disagree with it.
              value={row.value}
              data-setting={`llm-provider-${row.slug}`}
            />
          ))}
        </Group>
      ) : (
        <p className="px-5 py-8 text-center text-sm text-muted-foreground">
          No providers. This bot&apos;s Hermes lists none with an API key to set.
        </p>
      )}
    </div>
  )
}

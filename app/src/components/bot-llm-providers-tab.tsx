import { useEffect, useState } from "react"
import { useNavigate } from "react-router"

import { Banner } from "@/components/banner"
import {
  Caption,
  FormActions,
  Group,
  ValueRow,
  fieldInputClass,
  fieldLabelClass,
} from "@/components/settings-chrome"
import { Input } from "@/components/ui/input"
import { Spinner } from "@/components/ui/spinner"
import { botSubPath } from "@/lib/bot-subs"
import { connectionKey } from "@/lib/connection"
import type { Profile } from "@/lib/db"
import { READ_TIMEOUT_MS } from "@/lib/freshness"
import { getLlmProviders, setLlmProviderKey } from "@/lib/hermes"
import { providerRows, submittableKey, type LlmProviders } from "@/lib/llm-providers"

/**
 * The LLM Providers page: the API-key providers this bot's Hermes knows, one row each, its key drawn
 * as the mask the host made of it (`llm_providers.py`). The key itself never leaves the host, so
 * nothing here derives, reveals or compares one — a row's value is the string that arrived, and an
 * empty one is the *Not set* `ValueRow` already draws.
 *
 * A row opens its slot screen, whose one write is a key: the field starts empty, Save is dead until
 * the field holds something a key could be (`submittableKey`), and the screen then draws the block
 * that write answered — the row's new mask, made by the host.
 *
 * The page is only ever reached where the host advertises `llm_providers` (the gate is the route's
 * own, `bot-settings.tsx`'s `PAGE_META`), so a host that can't list them draws no page at all. The
 * custom endpoints are a later step.
 */
export function LlmProvidersTab({ profile }: { profile: Profile }) {
  const navigate = useNavigate()
  const { block, problem } = useLlmProviders(profile)

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
              onClick={() => navigate(botSubPath(profile.id, "llm-providers", "key", row.slug))}
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

/**
 * One provider's key, as the page's slot screen draws it (ADR 0055): the provider's own label and
 * line, its key as the host masked it, and the one form that replaces it.
 *
 * The field starts empty, never holding the mask: a mask is what the host made of a key, and sending
 * one back would be a write of nothing at all. Save is dead until `submittableKey` says the field
 * holds something a key could be, the host refuses a mask again on its own rule, and the answer to a
 * write is the fresh block — so the mask under the form is the host's new one, not the app's guess.
 */
export function LlmProviderKeyScreen({ profile, target }: { profile: Profile; target: string }) {
  const { block, problem, keep } = useLlmProviders(profile)
  const [draft, setDraft] = useState("")
  const [saving, setSaving] = useState(false)
  const [refusal, setRefusal] = useState<string>()

  if (!block)
    return problem ? (
      <Banner tone="warning">{problem}</Banner>
    ) : (
      <div className="flex items-center justify-center py-16" data-llm-provider-loading>
        <Spinner />
      </div>
    )

  const provider = block.providers.find((one) => one.slug === target)
  // The address is reachable by hand, so a slug this host doesn't list says so rather than drawing
  // a form whose write the host would refuse.
  if (!provider)
    return (
      <div className="flex flex-col gap-4" data-llm-provider-slot={target}>
        <p className="px-5 py-8 text-center text-sm text-muted-foreground">
          This bot&apos;s Hermes lists no provider by that name.
        </p>
      </div>
    )

  const submit = () => {
    if (!submittableKey(draft) || saving) return
    setSaving(true)
    setRefusal(undefined)
    void setLlmProviderKey(profile, target, draft.trim())
      .then((next) => {
        // The block the write answered is the one the screen draws now, mask and all.
        if (next) keep(next)
        setDraft("")
      })
      .catch((error: unknown) => {
        // Said where it was read: the host's own sentence, with the field kept so a retry is a tap.
        setRefusal(error instanceof Error ? error.message : "Couldn't save that key.")
      })
      .finally(() => setSaving(false))
  }

  return (
    <div className="flex flex-col gap-4" data-llm-provider-slot={provider.slug}>
      {refusal && (
        <Banner tone="error">
          <span role="alert">{refusal}</span>
        </Banner>
      )}
      <Group>
        <ValueRow
          title={provider.label}
          purpose={provider.description || undefined}
          value={provider.masked ?? ""}
          data-setting="llm-provider-mask"
        />
      </Group>
      <Caption>Replace key</Caption>
      <form
        className="flex flex-col gap-4"
        onSubmit={(event) => {
          event.preventDefault()
          submit()
        }}
      >
        <div className="flex flex-col gap-2">
          <label htmlFor="llm-provider-key" className={fieldLabelClass}>
            New key
          </label>
          <Input
            id="llm-provider-key"
            value={draft}
            type="password"
            autoComplete="off"
            autoCapitalize="off"
            autoCorrect="off"
            spellCheck={false}
            placeholder="The provider's API key"
            onChange={(event) => setDraft(event.target.value)}
            className={fieldInputClass}
            data-llm-key-field
          />
          <p className="px-1 text-sm text-muted-foreground">
            Saved on this bot&apos;s Hermes. The key is never shown again — only its first and last
            four.
          </p>
        </div>
        <FormActions disabled={!submittableKey(draft)} busy={saving} />
      </form>
    </div>
  )
}

/**
 * The page's block, and a write's answer folded into it: one read on the connection the page belongs
 * to, and the block a write answers kept where the screen is already drawing.
 *
 * The block a page draws belongs to the read that answered it: a page asked again draws nothing
 * until its own answer lands, so a failure never stands over the rows of the answer before it.
 */
function useLlmProviders(profile: Profile) {
  const [block, setBlock] = useState<LlmProviders>()
  const [problem, setProblem] = useState<string>()
  const connection = connectionKey(profile)

  useEffect(() => {
    let cancelled = false
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

  return {
    block,
    problem,
    /** A write answered: draw that block, and nothing of the read's refusal stands over it. */
    keep: (next: LlmProviders) => {
      setProblem(undefined)
      setBlock(next)
    },
  }
}

import { useCallback, useEffect, useRef, useState } from "react"
import { useLocation, useNavigate } from "react-router"
import { PlusIcon, Trash2Icon } from "lucide-react"

import { Banner } from "@/components/banner"
import {
  Caption,
  ConfirmDestructive,
  EditForm,
  FormActions,
  Group,
  ValueRow,
  fieldInputClass,
  fieldLabelClass,
  useHeaderAction,
} from "@/components/settings-chrome"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Spinner } from "@/components/ui/spinner"
import { botSubPath, type BotSub } from "@/lib/bot-subs"
import { botTabPath } from "@/lib/bot-tabs"
import { connectionKey } from "@/lib/connection"
import type { Profile } from "@/lib/db"
import { READ_TIMEOUT_MS } from "@/lib/freshness"
import { useLarge } from "@/lib/media"
import { useUnsavedChanges } from "@/lib/unsaved"
import {
  addLlmEndpoint,
  getLlmProviders,
  removeLlmEndpoint,
  removeLlmProviderKey,
  setLlmProviderKey,
} from "@/lib/hermes"
import {
  customEndpointId,
  endpointRows,
  providerRows,
  submittableEndpoint,
  submittableKey,
  type LlmEndpointDraft,
  type LlmProviders,
} from "@/lib/llm-providers"

/**
 * What the page says of a write whose answer carried no block: it can't say the write landed — a form
 * emptied and a mask left as it was would read as one that did — so it says that instead, in place,
 * with what was typed still in the field and the question still open.
 */
const UNREAD_ANSWER =
  "This host's answer couldn't be read, so nothing here can say the write landed."

/**
 * The LLM Providers page: the API-key providers this bot's Hermes knows and the custom endpoints it
 * holds, each row's key drawn as the mask the host made of it (`llm_providers.py`). The key itself
 * never leaves the host, so nothing here derives, reveals or compares one — a row's value is the
 * string that arrived, and an empty one is the *Not set* `ValueRow` already draws.
 *
 * The page draws its own sub-screens, the way every page of a bot's settings does: the address tells
 * this component which of them is on screen, and a sub-screen takes the page's place at either width
 * — below 1024px the route pushed it there, and from 1024px it is the pane the page would have
 * drawn in (ADR 0055). So the page's own screens are the page's business, and the settings screen
 * above it holds nothing of what this one holds.
 */
export function LlmProvidersTab({ profile, sub }: { profile: Profile; sub?: BotSub }) {
  const navigate = useNavigate()
  // The page's own address, which is where its sub-screens return to: a form's Cancel, and a write
  // that leaves the screen behind.
  const close = useCallback(
    () => navigate(botTabPath(profile.id, "llm-providers"), { replace: true }),
    [navigate, profile.id],
  )

  // The page's own `+`: the form that adds a custom endpoint, which is a screen of its own.
  if (sub?.id === "add") return <LlmEndpointAddScreen profile={profile} close={close} />
  // One provider's key: the page's own detail, named by the target the address carried.
  if (sub?.kind === "detail" && sub.item)
    return <LlmProviderKeyScreen profile={profile} target={sub.item} />
  return <ProvidersPage profile={profile} />
}

/**
 * The page itself: the providers the host's catalog knows and the custom endpoints it holds.
 *
 * A row opens its slot screen, whose one write is a key: the field starts empty, Save is dead until
 * the field holds something a key could be (`submittableKey`), and the screen then draws the block
 * that write answered — the row's new mask, made by the host. An endpoint's slot screen is the same
 * form under the endpoint's own name, with the base URL and model it runs reported muted above it;
 * its target is spelled `custom:<id>`, so one address names one key.
 *
 * The header's `+` adds one: a form of its own, drawn as a detail sub-screen, whose four fields are
 * an endpoint's whole shape. Its write is the host's own upsert, its refusals are the host's own
 * sentences, and the block it answers is the block the page draws — no second read between them.
 *
 * The page is only ever reached where the host advertises `llm_providers` (the gate is the route's
 * own, `bot-settings.tsx`'s `PAGE_META`), so a host that can't list them draws no page at all.
 */
function ProvidersPage({ profile }: { profile: Profile }) {
  const navigate = useNavigate()
  const { block, problem } = useLlmProviders(profile)
  // The page's own way to add one: the header's `+`, which opens the form as a sub-screen. Its
  // handler is `navigate` — stable across renders — because the header draws the node it was
  // published with and never re-renders for a change on the page below it.
  useHeaderAction(
    "llm-endpoint-add",
    <Button
      variant="outline"
      size="icon-lg"
      className="size-11 rounded-full"
      aria-label="Add a custom endpoint"
      title="Add a custom endpoint"
      data-llm-add-endpoint
      onClick={() => navigate(botSubPath(profile.id, "llm-providers", "add"))}
    >
      <PlusIcon />
    </Button>,
  )

  if (!block)
    return problem ? (
      <Banner tone="warning">{problem}</Banner>
    ) : (
      <div className="flex items-center justify-center py-16" data-llm-providers-loading>
        <Spinner />
      </div>
    )

  const rows = providerRows(block)
  // The endpoints are the same page's second list: a host with none draws no caption at all, since
  // a heading over nothing is a control that can't be pressed.
  const endpoints = endpointRows(block)
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
      {endpoints.length > 0 && (
        <>
          <Caption>Custom endpoints</Caption>
          <Group>
            {endpoints.map((endpoint) => (
              <ValueRow
                key={endpoint.id}
                title={endpoint.title}
                purpose={endpoint.purpose || undefined}
                value={endpoint.value}
                onClick={() =>
                  navigate(botSubPath(profile.id, "llm-providers", "key", endpoint.target))
                }
                data-setting={`llm-endpoint-${endpoint.id}`}
              />
            ))}
          </Group>
        </>
      )}
    </div>
  )
}

/**
 * One key, as the page's slot screen draws it (ADR 0055): a provider's own label and line, or an
 * endpoint's name over the base URL and model it runs, its key as the host masked it, and the one
 * form that replaces it. The target the address carried says which: a catalog slug, or `custom:<id>`.
 *
 * The field starts empty, never holding the mask: a mask is what the host made of a key, and sending
 * one back would be a write of nothing at all. Save is dead until `submittableKey` says the field
 * holds something a key could be, the host refuses a mask again on its own rule, and the answer to a
 * write is the fresh block — so the mask under the form is the host's new one, not the app's guess.
 *
 * Where a provider's key is set, the screen also offers to remove it — behind `ConfirmDestructive`,
 * whose question names the provider, because a removal is the one write here that can't be undone
 * from this screen. Cancel writes nothing at all, and the answer is again the fresh block, where the
 * row reads *Not set* and the action goes with the key it removed. A removal refused is said in the
 * question, which stays up, so a retry is one tap.
 *
 * An endpoint's own removal is the other resource: *Remove endpoint* takes the endpoint and its key
 * together, behind a question naming the endpoint. The host refuses the endpoint its model runs on —
 * deleting it would unpick the model — and that sentence stands on this screen, with the endpoint
 * still drawn and the question done, since nothing here can switch a model. A removal that lands
 * leaves this screen with nothing to report, so it returns to the page with the block that removal
 * answered: the row is gone from what the page draws, with no read in between.
 *
 * The two removals are never the same write: no key write on this screen deletes an endpoint, and no
 * endpoint removal touches another row's key.
 */
export function LlmProviderKeyScreen({ profile, target }: { profile: Profile; target: string }) {
  const navigate = useNavigate()
  const large = useLarge()
  const { block, problem, keep } = useLlmProviders(profile)
  // What the form is made again by: a write that landed, so its field holds nothing afterwards —
  // even the same key written twice changes no mask, and the field is emptied all the same.
  const [written, setWritten] = useState(0)
  const [saving, setSaving] = useState(false)
  const [refusal, setRefusal] = useState<string>()
  // The removal's own question, and the write it is holding open: `busy` keeps the dialog up while
  // the host is asked, so a refusal is read before the question is dismissed by hand.
  const [asking, setAsking] = useState(false)
  const [removing, setRemoving] = useState(false)

  if (!block)
    return problem ? (
      <Banner tone="warning">{problem}</Banner>
    ) : (
      <div className="flex items-center justify-center py-16" data-llm-provider-loading>
        <Spinner />
      </div>
    )

  // One address, one key: `custom:<id>` names an endpoint's, anything else a provider's slug.
  const endpointId = customEndpointId(target)
  const provider = endpointId ? undefined : block.providers.find((one) => one.slug === target)
  const endpoint = endpointId ? block.endpoints.find((one) => one.id === endpointId) : undefined
  // The address is reachable by hand, so a target this host doesn't list says so rather than drawing
  // a form whose write the host would refuse.
  if (!provider && !endpoint)
    return (
      <div className="flex flex-col gap-4" data-llm-provider-slot={target}>
        <p className="px-5 py-8 text-center text-sm text-muted-foreground">
          This bot&apos;s Hermes lists no provider or endpoint by that name.
        </p>
      </div>
    )

  // The mask this screen drew, as the row handed it over: the field must never send back the exact
  // string on screen, whatever shape a host made of it.
  const drawn = provider?.masked ?? endpoint?.masked

  const submit = (draft: string) => {
    if (!submittableKey(draft, drawn) || saving) return
    setSaving(true)
    setRefusal(undefined)
    void setLlmProviderKey(profile, target, draft.trim())
      .then((next) => {
        if (!next) {
          // No block came back, so the write may not have landed at all: say so, and keep the typed
          // key where it is rather than emptying the form over the mask it drew before.
          setRefusal(UNREAD_ANSWER)
          return
        }
        // The block the write answered is the one the screen draws now, mask and all — and the form
        // is made again holding nothing, so the key that was typed is not left in the field.
        keep(next)
        setWritten((count) => count + 1)
      })
      .catch((error: unknown) => {
        // Said where it was read: the host's own sentence, with the field kept so a retry is a tap.
        setRefusal(error instanceof Error ? error.message : "Couldn't save that key.")
      })
      .finally(() => setSaving(false))
  }

  const removeKey = () => {
    if (removing) return
    setRemoving(true)
    setRefusal(undefined)
    void removeLlmProviderKey(profile, target)
      .then((next) => {
        if (!next) {
          // An answer with no block can't say the key went, so the question stays up with the
          // sentence that says so, and the row is still drawn as it was.
          setRefusal(UNREAD_ANSWER)
          return
        }
        // The block the removal answered is the one the screen draws now: that row is *Not set*.
        keep(next)
        setAsking(false)
      })
      .catch((error: unknown) => {
        // Said in the question itself, which stays up: the host's words are read before it is
        // dismissed, and a retry is one tap.
        setRefusal(error instanceof Error ? error.message : "Couldn't remove that key.")
      })
      .finally(() => setRemoving(false))
  }

  const removeEndpoint = () => {
    if (!endpoint || removing) return
    setRemoving(true)
    setRefusal(undefined)
    void removeLlmEndpoint(profile, endpoint.id)
      .then((next) => {
        if (!next) {
          // An answer with no block can't say the endpoint went, and leaving the screen would read
          // as one that did: the sentence stands here, with the endpoint still drawn.
          setRefusal(UNREAD_ANSWER)
          setAsking(false)
          return
        }
        // The endpoint is gone, so this screen has nothing left to report: the page it returns to
        // draws the block the removal answered, without this row.
        navigate(botTabPath(profile.id, "llm-providers"), { replace: true, state: { llm: next } })
      })
      .catch((error: unknown) => {
        // The host's sentence, on the screen rather than in the question: the model this endpoint
        // runs has to be switched somewhere this page can't reach, so a retry from here could only
        // fail the same way. The question is done and the endpoint is drawn as it was.
        setRefusal(error instanceof Error ? error.message : "Couldn't remove that endpoint.")
        setAsking(false)
      })
      .finally(() => setRemoving(false))
  }

  return (
    <div className="flex flex-col gap-4" data-llm-provider-slot={target}>
      {refusal && (
        <Banner tone="error">
          <span role="alert">{refusal}</span>
        </Banner>
      )}
      <Group>
        {endpoint ? (
          <>
            {/* The endpoint's own name over its key, then the two fields this page only reports:
                the base URL and the model, each muted because neither is the page's to claim. */}
            <ValueRow
              title={endpoint.name}
              value={endpoint.masked ?? ""}
              data-setting="llm-provider-mask"
            />
            <ValueRow
              title="Base URL"
              value={endpoint.base_url}
              muted
              data-setting="llm-endpoint-base-url"
            />
            <ValueRow
              title="Model"
              value={endpoint.model}
              muted
              data-setting="llm-endpoint-model"
            />
          </>
        ) : provider ? (
          <ValueRow
            title={provider.label}
            purpose={provider.description || undefined}
            value={provider.masked ?? ""}
            data-setting="llm-provider-mask"
          />
        ) : null}
      </Group>
      <Caption>Replace key</Caption>
      {/* The app's own edit form, so the field is the one every secret in Settings is typed into: a
          show/hide toggle, the screen's unsaved-changes guard, and a Save that waits. `saveable` is
          `submittableKey` rather than "anything typed", since a mask is a thing this field must
          never write. */}
      <EditForm
        key={`llm-key-${written}`}
        label="New key"
        value=""
        placeholder={endpoint ? "The endpoint's API key" : "The provider's API key"}
        kind="secret"
        surface={large ? "card" : "screen"}
        saveable={(next) => submittableKey(next, drawn)}
        busy={saving}
        onSave={submit}
      />
      {provider?.masked && (
        // Below Replace, and only where there is a key to remove: a control that writes nothing
        // isn't offered. The mask is the presence — there is no second flag to disagree with it.
        // An endpoint's key is a step of its own, so no removal is drawn on this screen.
        <Group>
          <Button
            type="button"
            variant="ghost"
            className="h-11 w-full justify-start rounded-full text-destructive"
            onClick={() => {
              setRefusal(undefined)
              setAsking(true)
            }}
            data-llm-remove-key
          >
            <Trash2Icon data-icon="inline-start" />
            Remove key
          </Button>
        </Group>
      )}
      {endpoint && (
        // The endpoint's own resource, removed whole: its entry and its key go together, so this is
        // offered wherever the endpoint is, key or no key.
        <Group>
          <Button
            type="button"
            variant="ghost"
            className="h-11 w-full justify-start rounded-full text-destructive"
            onClick={() => {
              setRefusal(undefined)
              setAsking(true)
            }}
            data-llm-remove-endpoint
          >
            <Trash2Icon data-icon="inline-start" />
            Remove endpoint
          </Button>
        </Group>
      )}
      {provider && (
        <ConfirmDestructive
          open={asking}
          title={`Remove ${provider.label}'s key?`}
          description={
            refusal ? (
              <span role="alert">{refusal}</span>
            ) : (
              "Its key is deleted from this bot's Hermes, and anything using it stops working until a new one is set."
            )
          }
          confirmLabel="Remove"
          busy={removing}
          onOpenChange={setAsking}
          onConfirm={removeKey}
        />
      )}
      {endpoint && (
        <ConfirmDestructive
          open={asking}
          title={`Remove ${endpoint.name}?`}
          description="The endpoint and its key are deleted from this bot's Hermes. Anything pinned to it stops working."
          confirmLabel="Remove"
          busy={removing}
          onOpenChange={setAsking}
          onConfirm={removeEndpoint}
        />
      )}
    </div>
  )
}

/**
 * A custom endpoint added: the form the page's `+` opens, drawn as a sub-screen of its own.
 *
 * The four fields are the endpoint's whole shape — a name, the base URL and model it runs, and the
 * key — and Save is dead until each of them says something a write could use (`submittableEndpoint`,
 * so a mask the page was handed is never one of them). The write is the host's own: it validates the
 * URL, slugs the id, writes the entry and puts the key in the bot's `.env`, so a refusal (a URL with
 * no host, a name an endpoint already carries) is the host's sentence, shown here in place with the
 * fields kept so a retry is one tap.
 *
 * On success the form leaves and the block that write answered is handed to the page with the
 * navigation: the page draws the new row — its id as the host slugged it, its key as the host masked
 * it — rather than asking again for what it was just told.
 */
export function LlmEndpointAddScreen({
  profile,
  close,
}: {
  profile: Profile
  /** The page's own address: where the form's Cancel and a finished write both go. */
  close: () => void
}) {
  const navigate = useNavigate()
  const [draft, setDraft] = useState<LlmEndpointDraft>({
    name: "",
    base_url: "",
    model: "",
    key: "",
  })
  const [saving, setSaving] = useState(false)
  const [refusal, setRefusal] = useState<string>()
  const ready = submittableEndpoint(draft)
  // A back would throw away what was typed, so the screen holds a draft the way every other
  // Settings form does: whatever any one of the four fields says is a change no Save has taken.
  useUnsavedChanges(Object.values(draft).some((held) => held.length > 0))

  const field = (key: keyof LlmEndpointDraft) => ({
    value: draft[key],
    onChange: (event: { target: { value: string } }) =>
      setDraft((held) => ({ ...held, [key]: event.target.value })),
  })

  const submit = () => {
    if (!ready || saving) return
    setSaving(true)
    setRefusal(undefined)
    void addLlmEndpoint(profile, draft)
      .then((next) => {
        // The block the write answered is the one the page draws: it rides this navigation, so no
        // read of the page's own can stand between the write and the row it added.
        navigate(botTabPath(profile.id, "llm-providers"), {
          replace: true,
          state: next ? { llm: next } : undefined,
        })
      })
      .catch((error: unknown) => {
        // Said where it was read: the host's own sentence, with the fields kept.
        setRefusal(error instanceof Error ? error.message : "Couldn't add that endpoint.")
        setSaving(false)
      })
  }

  return (
    <div className="flex flex-col gap-4" data-llm-endpoint-add>
      {refusal && (
        <Banner tone="error">
          <span role="alert">{refusal}</span>
        </Banner>
      )}
      <form
        className="flex flex-col gap-4"
        onSubmit={(event) => {
          event.preventDefault()
          submit()
        }}
      >
        <div className="flex flex-col gap-2">
          <label htmlFor="llm-endpoint-name" className={fieldLabelClass}>
            Name
          </label>
          <Input
            id="llm-endpoint-name"
            autoComplete="off"
            placeholder="Home box"
            {...field("name")}
            className={fieldInputClass}
            data-llm-endpoint-name
          />
        </div>
        <div className="flex flex-col gap-2">
          <label htmlFor="llm-endpoint-base-url" className={fieldLabelClass}>
            Base URL
          </label>
          <Input
            id="llm-endpoint-base-url"
            type="url"
            inputMode="url"
            autoComplete="off"
            autoCapitalize="off"
            autoCorrect="off"
            spellCheck={false}
            placeholder="http://127.0.0.1:8080/v1"
            {...field("base_url")}
            className={fieldInputClass}
            data-llm-endpoint-base-url
          />
        </div>
        <div className="flex flex-col gap-2">
          <label htmlFor="llm-endpoint-model" className={fieldLabelClass}>
            Model
          </label>
          <Input
            id="llm-endpoint-model"
            autoComplete="off"
            autoCapitalize="off"
            autoCorrect="off"
            spellCheck={false}
            placeholder="The model this endpoint serves"
            {...field("model")}
            className={fieldInputClass}
            data-llm-endpoint-model
          />
        </div>
        <div className="flex flex-col gap-2">
          <label htmlFor="llm-endpoint-key" className={fieldLabelClass}>
            API key
          </label>
          <Input
            id="llm-endpoint-key"
            type="password"
            autoComplete="off"
            autoCapitalize="off"
            autoCorrect="off"
            spellCheck={false}
            placeholder="The endpoint's API key"
            {...field("key")}
            className={fieldInputClass}
            data-llm-endpoint-key
          />
        </div>
        <FormActions onCancel={close} disabled={!ready} busy={saving} />
      </form>
    </div>
  )
}

/**
 * The page's block, and a write's answer folded into it: one read on the connection the page belongs
 * to, and the block a write answers kept where the screen is already drawing.
 *
 * The block a page draws belongs to the read that answered it: a page asked again draws nothing
 * until its own answer lands, so a failure never stands over the rows of the answer before it. A
 * block a write answered is the exception and the point — it rides the navigation that returns to
 * the page, and is drawn once instead of read again.
 */
function useLlmProviders(profile: Profile) {
  const location = useLocation()
  const navigate = useNavigate()
  // The block a screen that wrote one hands over: read once, then let go of — so a page returned to
  // later asks for itself and a stale answer can never be drawn twice.
  const handed = useRef((location.state as { llm?: LlmProviders } | null)?.llm)
  const [block, setBlock] = useState<LlmProviders | undefined>(handed.current)
  const [problem, setProblem] = useState<string>()
  const connection = connectionKey(profile)
  // This screen's own address, for the replace that takes the block off the entry it rode in on.
  const here = `${location.pathname}${location.search}`

  useEffect(() => {
    let cancelled = false
    if (handed.current) {
      // Already the host's answer, and a newer one than any read could give: asking again would
      // draw the answer to a read over the answer to the write. The entry it rode on is left holding
      // nothing, though, because a history entry outlives this mount: a page returned to it later
      // must read the host rather than draw the block captured when the write happened. `quiet` says
      // the screen didn't move, so the replace doesn't animate it.
      handed.current = undefined
      navigate(here, { replace: true, state: { quiet: true } })
      return
    }
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

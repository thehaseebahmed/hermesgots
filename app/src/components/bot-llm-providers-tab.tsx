import { useCallback, useEffect, useRef, useState, type ComponentProps } from "react"
import { useLocation, useNavigate } from "react-router"
import { ChevronDownIcon, EyeIcon, EyeOffIcon, PlusIcon } from "lucide-react"

import { Banner } from "@/components/banner"
import {
  Caption,
  ConfirmDestructive,
  EditForm,
  FormActions,
  FormFoot,
  Group,
  PickList,
  PickSurface,
  ValueRow,
  fieldInnerClass,
  fieldInputClass,
  fieldLabelClass,
  formColumnClass,
  useHeaderAction,
  useHeaderTitle,
} from "@/components/settings-chrome"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import {
  InputGroup,
  InputGroupAddon,
  InputGroupButton,
  InputGroupInput,
} from "@/components/ui/input-group"
import { Spinner } from "@/components/ui/spinner"
import { botSubPath, type BotSub } from "@/lib/bot-subs"
import { botTabPath } from "@/lib/bot-tabs"
import { connectionKey } from "@/lib/connection"
import type { Profile } from "@/lib/db"
import { READ_TIMEOUT_MS } from "@/lib/freshness"
import { useLarge } from "@/lib/media"
import { useUnsavedChanges } from "@/lib/unsaved"
import {
  getLlmProviders,
  removeLlmEndpoint,
  removeLlmProviderKey,
  saveLlmEndpoint,
  setLlmProviderKey,
} from "@/lib/hermes"
import {
  customEndpointId,
  editEndpointBody,
  endpointChanges,
  endpointFieldsOf,
  endpointRows,
  newEndpointBody,
  providerRows,
  saveableEndpointEdit,
  submittableEndpoint,
  submittableKey,
  customKeyEnv,
  TRANSPORTS,
  transportLabel,
  type LlmEndpoint,
  type LlmEndpointDraft,
  type LlmEndpointFields,
  type LlmProviders,
} from "@/lib/llm-providers"
import { cn } from "@/lib/utils"

/**
 * What the page says of a write whose answer carried no block: it can't say the write landed — a form
 * emptied and a mask left as it was would read as one that did — so it says that instead, in place,
 * with what was typed still in the field and the question still open.
 */
const UNREAD_ANSWER =
  "This host's answer couldn't be read, so nothing here can say the write landed."

/**
 * What a key field says where the row it belongs to holds none: there is no mask to show as what is
 * there, so the field is a field with a hint and nothing more. The host's mask is the placeholder
 * wherever there is one (`llm_providers.py` hands this page the mask and never the key).
 */
const NO_KEY_HINT = "Paste the key"

/**
 * The LLM Providers page: the API-key providers this bot's Hermes knows and the custom endpoints it
 * holds, each row's key drawn as the mask the host made of it (`llm_providers.py`). The key itself
 * never leaves the host, so nothing here derives, reveals or compares one — a row's value is the
 * string that arrived, and an empty one is the *Not set* `ValueRow` already draws.
 *
 * A row opens one form for its whole slot. A provider's form holds the key alone and takes the row's
 * mask as its **placeholder**, so an empty field writes nothing and only a typed key replaces one. A
 * custom endpoint's form holds every setting its row does — the name, the base URL and model, the
 * transport, the session-affinity header, and the key — filled with what the host holds, and it
 * posts only what changed. In both, the actions stand at the screen's foot: Delete on the left where
 * the slot holds something to delete, Cancel in its place where nothing does, and the back arrow
 * always the way out without a word.
 *
 * The page draws its own sub-screens, the way every page of a bot's settings does: the address tells
 * this component which of them is on screen, and a sub-screen takes the page's place at either width
 * — below 1024px the route pushed it there, and from 1024px it is the pane the page would have drawn
 * in (ADR 0055). So the page's own screens are the page's business, and the settings screen above it
 * holds nothing of what this one holds.
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
  // One row's slot, named by the target the address carried: a provider's catalog slug, whose whole
  // setting is its key, or an endpoint's `custom:<id>`, whose setting is everything its row holds.
  if (sub?.kind === "detail" && sub.item) {
    const endpointId = customEndpointId(sub.item)
    return endpointId ? (
      <LlmEndpointScreen profile={profile} id={endpointId} />
    ) : (
      <LlmProviderKeyScreen profile={profile} target={sub.item} close={close} />
    )
  }
  return <ProvidersPage profile={profile} />
}

/**
 * The page itself: the providers the host's catalog knows and the custom endpoints it holds. A row
 * opens its slot's form; the header's `+` adds one.
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
              key={row.target}
              title={row.title}
              purpose={row.purpose || undefined}
              // The mask, or nothing: `ValueRow` draws an empty value as *Not set*, which is the
              // truth about a provider with no key — there is no separate flag to disagree with it.
              value={row.value}
              onClick={() => navigate(botSubPath(profile.id, "llm-providers", "key", row.target))}
              data-setting={`llm-provider-${row.target}`}
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
            {endpoints.map((endpoint) => {
              // The endpoint's own id, read back out of the address its key is written to: the row's
              // target is one fact, and the name this page knows the endpoint by is that fact read.
              const id = customEndpointId(endpoint.target)
              return (
                <ValueRow
                  key={id}
                  title={endpoint.title}
                  purpose={endpoint.purpose || undefined}
                  value={endpoint.value}
                  onClick={() =>
                    navigate(botSubPath(profile.id, "llm-providers", "key", endpoint.target))
                  }
                  data-setting={`llm-endpoint-${id}`}
                />
              )
            })}
          </Group>
        </>
      )}
    </div>
  )
}

/**
 * One provider's key: the slot screen a provider's row opens. The screen is titled for what it does
 * (*API key*) and the field for whose key it is, so the screen and its field never say the same two
 * words; the mask the row drew is the field's **placeholder** — what is there is what the field
 * says — and an empty field therefore writes nothing at all.
 *
 * Save is dead until `submittableKey` says the field holds something a key could be (a mask pasted
 * back is refused by its own string), and the answer to a write is the fresh block, so the mask the
 * field then shows is the host's new one rather than the app's guess.
 *
 * Where the provider holds a key, the bar leads with *Delete key* — behind `ConfirmDestructive`, whose
 * question names the provider — and elsewhere with *Cancel*, which is the back arrow's own promise:
 * a screen with nothing to delete has nothing to undo. A removal refused or unreadable is said on the
 * screen, with the key still drawn.
 */
export function LlmProviderKeyScreen({
  profile,
  target,
  close,
}: {
  profile: Profile
  target: string
  /** The page's own address: where Cancel, and a key screen with nothing to cancel, lead. */
  close: () => void
}) {
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
  // The heading carries the verb and names whose key this is; the route knows only the slug. Asked
  // before the early returns, since a hook after one would run only once the block landed.
  const provider = block?.providers.find((one) => one.slug === target)
  useHeaderTitle(block ? `Edit ${provider?.label ?? target}` : undefined)

  if (!block)
    return problem ? (
      <Banner tone="warning">{problem}</Banner>
    ) : (
      <div className="flex items-center justify-center py-16" data-llm-provider-loading>
        <Spinner />
      </div>
    )

  // The address is reachable by hand, so a target this host doesn't list says so rather than drawing
  // a form whose write the host would refuse.
  if (!provider)
    return (
      <div className="flex flex-col gap-4" data-llm-provider-slot={target}>
        <p className="px-5 py-8 text-center text-sm text-muted-foreground">
          This bot&apos;s Hermes lists no provider by that name.
        </p>
      </div>
    )

  // The mask this screen drew, as the row handed it over: the field must never send back the exact
  // string on screen, whatever shape a host made of it.
  const masked = provider.masked

  const submit = (draft: string) => {
    if (!submittableKey(draft, masked) || saving) return
    setSaving(true)
    setRefusal(undefined)
    void setLlmProviderKey(profile, target, draft.trim())
      .then((next) => {
        if (!next) {
          // No block came back, so the write may not have landed at all: say so, and keep the typed
          // key where it is rather than emptying the field over the mask it drew before.
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

  const remove = () => {
    if (removing) return
    setRemoving(true)
    setRefusal(undefined)
    void removeLlmProviderKey(profile, target)
      .then((next) => {
        if (!next) {
          // An answer with no block can't say the key went, so the question stays up with the
          // sentence that says so, and the field still holds the mask it drew.
          setRefusal(UNREAD_ANSWER)
          return
        }
        // The block the removal answered is the one the screen draws now: that row is *Not set*, the
        // field falls back to a hint, and with nothing left to delete the bar offers Cancel.
        keep(next)
        setAsking(false)
        setWritten((count) => count + 1)
      })
      .catch((error: unknown) => {
        // Said in the question itself, which stays up: the host's words are read before it is
        // dismissed, and a retry is one tap.
        setRefusal(error instanceof Error ? error.message : "Couldn't remove that key.")
      })
      .finally(() => setRemoving(false))
  }

  return (
    <div className="flex flex-1 flex-col gap-4" data-llm-provider-slot={target}>
      {refusal && (
        <Banner tone="error">
          <span role="alert">{refusal}</span>
        </Banner>
      )}
      {/* The app's own edit form, so the field is the one every secret in Settings is typed into: a
          show/hide toggle, the screen's unsaved-changes guard, and a Save that waits. The mask is the
          placeholder rather than a value, so a field left alone writes nothing. The bar's left action
          is the key's removal where the host holds one — a slot with nothing to delete leads with
          Cancel instead, which the back arrow already promises. */}
      <EditForm
        key={`llm-key-${written}`}
        label={provider.env || "API_KEY"}
        value=""
        placeholder={masked ?? NO_KEY_HINT}
        kind="secret"
        surface={large ? "card" : "screen"}
        saveable={(next) => submittableKey(next, masked)}
        busy={saving}
        onSave={submit}
        onReset={
          masked
            ? () => {
                setRefusal(undefined)
                setAsking(true)
              }
            : undefined
        }
        resetLabel="Delete"
        resetDestructive
        onCancel={masked ? undefined : close}
      />
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
        onConfirm={remove}
      />
    </div>
  )
}

/**
 * One custom endpoint's whole setting: the slot screen an endpoint's row opens, under the endpoint's
 * own name — a reader who lands here by address knows which endpoint they are editing, which their
 * target `custom:<id>` does not say — and one form holding every field the host keeps for it.
 *
 * The read is the page's own block again (`GET llm-providers`), because the endpoints' settings arrive
 * with it; a row that has gone from the host since the address was written says so rather than
 * drawing a form whose write the host would refuse. The form itself is remounted on the block each
 * write answers, so the fields it then holds are the host's, and the key field is empty with the new
 * mask as its placeholder.
 */
export function LlmEndpointScreen({
  profile,
  id,
}: {
  profile: Profile
  /** The endpoint this address names, read out of `custom:<id>`. */
  id: string
}) {
  const navigate = useNavigate()
  const { block, problem, keep } = useLlmProviders(profile)
  const [written, setWritten] = useState(0)
  const endpoint = block?.endpoints.find((one) => one.id === id)
  // A form's heading carries the verb, and names what it edits: a provider by its label, an endpoint
  // as the custom provider it is — the route knows only the id, and the id is not a name.
  useHeaderTitle("Edit Custom Provider")
  // A removal that landed leaves this screen with nothing to report: the page draws the block that
  // removal answered, with no read in between.
  const removed = useCallback(
    (next: LlmProviders) =>
      navigate(botTabPath(profile.id, "llm-providers"), { replace: true, state: { llm: next } }),
    [navigate, profile.id],
  )

  if (!block)
    return problem ? (
      <Banner tone="warning">{problem}</Banner>
    ) : (
      <div className="flex items-center justify-center py-16" data-llm-endpoint-loading>
        <Spinner />
      </div>
    )

  if (!endpoint)
    return (
      <div className="flex flex-col gap-4" data-llm-endpoint-slot={id}>
        <p className="px-5 py-8 text-center text-sm text-muted-foreground">
          This bot&apos;s Hermes lists no custom endpoint by that name.
        </p>
      </div>
    )

  return (
    <EndpointForm
      key={`${id}:${written}`}
      profile={profile}
      endpoint={endpoint}
      keep={keep}
      onWrite={() => setWritten((count) => count + 1)}
      onRemoved={removed}
    />
  )
}

/**
 * One endpoint's form, as the screen the route pushed (or the pane beside the page from 1024px): a
 * field per setting the host keeps, filled with what the row holds, and the actions on the screen's
 * floor.
 *
 * Save is offered for a form that holds something worth writing — a field that differs from the row,
 * or a key typed over the mask — so opening a row and pressing Save writes nothing. What it writes is
 * `editEndpointBody`: the id, the fields that differ, and the key only where one was typed, never the
 * mask. A setting cleared is a value like any other (the transport's empty string is Automatic, the
 * header's is none), so a user can take one back off the host.
 *
 * *Delete endpoint* is the bar's left action wherever the endpoint is — its entry and its key are one
 * resource — and asks first. The host refuses the endpoint the bot's model runs on, in its own
 * sentence, which stands on this screen with the endpoint still drawn; nothing here can switch a
 * model, so a retry from here could only fail the same way.
 */
function EndpointForm({
  profile,
  endpoint,
  keep,
  onWrite,
  onRemoved,
}: {
  profile: Profile
  endpoint: LlmEndpoint
  keep: (next: LlmProviders) => void
  /** A write that landed: the screen remounts this form on the block it answered. */
  onWrite: () => void
  onRemoved: (next: LlmProviders) => void
}) {
  const large = useLarge()
  // The row as the form opened on it, and the values it holds now: the first is what "changed" is
  // measured against, so a field typed back to where it started offers no Save again.
  const [held] = useState<LlmEndpointFields>(() => endpointFieldsOf(endpoint))
  const [draft, setDraft] = useState<LlmEndpointFields>(() => endpointFieldsOf(endpoint))
  const [key, setKey] = useState("")
  const [saving, setSaving] = useState(false)
  const [refusal, setRefusal] = useState<string>()
  const [asking, setAsking] = useState(false)
  const [removing, setRemoving] = useState(false)

  const masked = endpoint.masked
  const ready = saveableEndpointEdit(held, draft, key, masked)
  const changed =
    key.trim().length > 0 || Object.keys(endpointChanges(held, draft)).length > 0
  // A back would throw the form away, so the screen asks first where it is the screen: a pane beside
  // the page is the same form, and its back leaves it.
  useUnsavedChanges(!large && changed)

  const set = (field: keyof LlmEndpointFields) => (value: string) =>
    setDraft((held) => ({ ...held, [field]: value }))

  const submit = () => {
    if (!ready || saving) return
    setSaving(true)
    setRefusal(undefined)
    void saveLlmEndpoint(profile, editEndpointBody(endpoint.id, held, draft, key, masked))
      .then((next) => {
        if (!next) {
          // The host answered without its block, so nothing here can say the write landed: say that,
          // and keep every field as the user left it rather than redrawing over the answer.
          setRefusal(UNREAD_ANSWER)
          return
        }
        keep(next)
        onWrite()
      })
      .catch((error: unknown) => {
        // Said where it was read: the host's own sentence, with the fields kept so a retry is a tap.
        setRefusal(error instanceof Error ? error.message : "Couldn't save that endpoint.")
      })
      .finally(() => setSaving(false))
  }

  const remove = () => {
    if (removing) return
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
        onRemoved(next)
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
    <>
      {refusal && (
        <Banner tone="error">
          <span role="alert">{refusal}</span>
        </Banner>
      )}
      <form
        className={formColumnClass}
        data-llm-endpoint-form
        onSubmit={(event) => {
          event.preventDefault()
          submit()
        }}
      >
        <div className="flex flex-col gap-4">
          <Field
            name="name"
            label="NAME"
            autoComplete="off"
            placeholder="Home box"
            value={draft.name}
            onChange={(event) => set("name")(event.target.value)}
          />
          <Field
            name="base-url"
            label="API"
            type="url"
            inputMode="url"
            autoComplete="off"
            autoCapitalize="off"
            autoCorrect="off"
            spellCheck={false}
            placeholder="http://127.0.0.1:8080/v1"
            value={draft.base_url}
            onChange={(event) => set("base_url")(event.target.value)}
          />
          <Field
            name="model"
            label="DEFAULT_MODEL"
            autoComplete="off"
            autoCapitalize="off"
            autoCorrect="off"
            spellCheck={false}
            placeholder="The model this endpoint serves"
            value={draft.model}
            onChange={(event) => set("model")(event.target.value)}
          />
          <TransportField value={draft.transport} onChange={set("transport")} />
          <Field
            name="affinity"
            label="SESSION_AFFINITY_HEADER"
            autoComplete="off"
            autoCapitalize="off"
            autoCorrect="off"
            spellCheck={false}
            placeholder="x-litellm-session-id"
            value={draft.affinity}
            onChange={(event) => set("affinity")(event.target.value)}
          />
          <KeyField
            id="llm-endpoint-key"
            label={endpoint.key_env || "API_KEY"}
            attribute="data-llm-endpoint-key"
            placeholder={masked ?? NO_KEY_HINT}
            value={key}
            onChange={setKey}
          />
        </div>
        <FormFoot>
          <FormActions
            onReset={() => {
              setRefusal(undefined)
              setAsking(true)
            }}
            resetLabel="Delete"
            destructive
            disabled={!ready}
            busy={saving}
          />
        </FormFoot>
      </form>
      <ConfirmDestructive
        open={asking}
        title={`Remove ${endpoint.name}?`}
        description="The endpoint and its key are deleted from this bot's Hermes. Anything pinned to it stops working."
        confirmLabel="Remove"
        busy={removing}
        onOpenChange={setAsking}
        onConfirm={remove}
      />
    </>
  )
}

/**
 * A custom endpoint added: the form the page's `+` opens, drawn as a sub-screen of its own, holding
 * the same settings the row's form does. The four it needs are a name, a base URL, a model and a key;
 * the transport and the affinity header are offered where the endpoint wants them and sent only when
 * they were given (`newEndpointBody`), so a plain OpenAI-compatible endpoint is still four fields.
 *
 * The write is the host's own: it validates the URL, slugs the id, writes the entry and puts the key
 * in the bot's `.env`, so a refusal (a URL with no host, a name an endpoint already carries) is the
 * host's sentence, shown here in place with the fields kept so a retry is one tap. On success the form
 * leaves and the block that write answered is handed to the page with the navigation: the page draws
 * the new row — its id as the host slugged it, its key as the host masked it — rather than asking
 * again for what it was just told.
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
    transport: "",
    affinity: "",
  })
  const [saving, setSaving] = useState(false)
  const [refusal, setRefusal] = useState<string>()
  const ready = submittableEndpoint(draft)
  // A back would throw away what was typed, so the screen holds a draft the way every other
  // Settings form does: whatever any one of the fields says is a change no Save has taken.
  useUnsavedChanges(Object.values(draft).some((held) => held.length > 0))

  const set = (field: keyof LlmEndpointDraft) => (value: string) =>
    setDraft((held) => ({ ...held, [field]: value }))

  const submit = () => {
    if (!ready || saving) return
    setSaving(true)
    setRefusal(undefined)
    void saveLlmEndpoint(profile, newEndpointBody(draft))
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
    <>
      {refusal && (
        <Banner tone="error">
          <span role="alert">{refusal}</span>
        </Banner>
      )}
      <div data-llm-endpoint-add>
        <form
          className={formColumnClass}
          data-llm-endpoint-add-form
          onSubmit={(event) => {
            event.preventDefault()
            submit()
          }}
        >
          <div className="flex flex-col gap-4">
            <Field
              name="name"
              label="NAME"
              autoComplete="off"
              placeholder="Home box"
              value={draft.name}
              onChange={(event) => set("name")(event.target.value)}
            />
            <Field
              name="base-url"
              label="API"
              type="url"
              inputMode="url"
              autoComplete="off"
              autoCapitalize="off"
              autoCorrect="off"
              spellCheck={false}
              placeholder="http://127.0.0.1:8080/v1"
              value={draft.base_url}
              onChange={(event) => set("base_url")(event.target.value)}
            />
            <Field
              name="model"
              label="DEFAULT_MODEL"
              autoComplete="off"
              autoCapitalize="off"
              autoCorrect="off"
              spellCheck={false}
              placeholder="The model this endpoint serves"
              value={draft.model}
              onChange={(event) => set("model")(event.target.value)}
            />
            <TransportField
              value={draft.transport ?? ""}
              onChange={set("transport")}
            />
            <Field
              name="affinity"
              label="SESSION_AFFINITY_HEADER"
              autoComplete="off"
              autoCapitalize="off"
              autoCorrect="off"
              spellCheck={false}
              placeholder="x-litellm-session-id"
              value={draft.affinity ?? ""}
              onChange={(event) => set("affinity")(event.target.value)}
            />
            <KeyField
              id="llm-endpoint-key"
              label={customKeyEnv(draft.name)}
              attribute="data-llm-endpoint-key"
              placeholder="The endpoint's API key"
              value={draft.key}
              onChange={set("key")}
            />
          </div>
          <FormFoot>
            <FormActions onCancel={close} disabled={!ready} busy={saving} />
          </FormFoot>
        </form>
      </div>
    </>
  )
}

/**
 * One labelled field of an endpoint's form: the label above, and the filled pill a thumb can find.
 * `name` is both the label's target and the mark the field is read by (`data-llm-endpoint-model`),
 * so a test names the setting rather than a position, and a name an endpoint grows later is a field
 * here and nowhere else.
 */
function Field({
  name,
  label,
  ...input
}: { name: string; label: string } & Omit<ComponentProps<typeof Input>, "className" | "id">) {
  const id = `llm-endpoint-${name}`
  return (
    <div className="flex flex-col gap-2">
      <label htmlFor={id} className={fieldLabelClass}>
        {label}
      </label>
      <Input id={id} className={fieldInputClass} {...{ [`data-llm-endpoint-${name}`]: name }} {...input} />
    </div>
  )
}

/**
 * The key field an endpoint's form holds: filled, typed into at 16px, and masked behind a show toggle
 * — the same field a provider's key is typed into. The mask the row drew is its placeholder, so an
 * empty field keeps the key that is there and only a typed key replaces one.
 */
function KeyField({
  id,
  label,
  attribute,
  placeholder,
  value,
  onChange,
}: {
  id: string
  label: string
  /** The mark the field is read by: the endpoint's form and the add form name it the same. */
  attribute: string
  placeholder: string
  value: string
  onChange: (value: string) => void
}) {
  const [shown, setShown] = useState(false)
  return (
    <div className="flex flex-col gap-2">
      <label htmlFor={id} className={fieldLabelClass}>
        {label}
      </label>
      <InputGroup className="h-12 rounded-full bg-muted">
        <InputGroupInput
          id={id}
          className={fieldInnerClass}
          autoComplete="off"
          autoCapitalize="off"
          autoCorrect="off"
          spellCheck={false}
          type={shown ? "text" : "password"}
          placeholder={placeholder}
          value={value}
          onChange={(event) => onChange(event.target.value)}
          {...{ [attribute]: true }}
        />
        <InputGroupAddon align="inline-end">
          <InputGroupButton
            size="icon-sm"
            className="mr-1 size-10 rounded-full"
            aria-label={shown ? "Hide key" : "Show key"}
            onClick={() => setShown((open) => !open)}
          >
            {shown ? <EyeOffIcon /> : <EyeIcon />}
          </InputGroupButton>
        </InputGroupAddon>
      </InputGroup>
    </div>
  )
}

/**
 * The transport an endpoint sends on, as a pick: the filled pill a field is, saying the choice it
 * holds, and the four the host itself names. Automatic is a choice rather than a blank — an endpoint
 * that pins nothing is the ordinary case, and the runtime then guesses from the address — and the
 * empty string is how the host spells it, so Automatic is what the pick writes back.
 */
function TransportField({
  value,
  onChange,
}: {
  value: string
  onChange: (value: string) => void
}) {
  const [open, setOpen] = useState(false)
  return (
    <div className="flex flex-col gap-2">
      <span id="llm-endpoint-transport-label" className={fieldLabelClass}>
        TRANSPORT
      </span>
      <button
        type="button"
        id="llm-endpoint-transport"
        aria-labelledby="llm-endpoint-transport-label"
        data-llm-endpoint-transport
        onClick={() => setOpen(true)}
        className={cn(fieldInputClass, "flex items-center justify-between gap-2 text-left")}
      >
        <span className="truncate">{transportLabel(value)}</span>
        <ChevronDownIcon className="size-4 shrink-0 text-muted-foreground" />
      </button>
      <PickSurface open={open} onOpenChange={setOpen} title="Transport">
        <PickList
          label="Transport"
          searchable={false}
          selected={value}
          options={TRANSPORTS.map((one) => ({ id: one.value, label: one.label }))}
          onPick={(next) => {
            onChange(next)
            setOpen(false)
          }}
        />
      </PickSurface>
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

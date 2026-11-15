import { useState } from "react"
import { useNavigate } from "react-router"

import { ConfirmDestructive } from "@/components/confirm-destructive"
import {
  Caption,
  DestructiveButton,
  EditCard,
  EditForm,
  Group,
  ValueRow,
} from "@/components/settings-chrome"
import { botSubPath, type BotSub } from "@/lib/bot-subs"
import type { Profile } from "@/lib/db"
import { clearNtfyTarget, saveNtfyField, useNtfyTarget, type NtfyField } from "@/lib/push"
import {
  NTFY_DEFAULT_SERVER,
  mintTopic,
  ntfyServer,
  ntfyTokenOk,
  ntfyTopicOk,
  type NtfyState,
} from "@/lib/push-transport"

/** The plugin feature a bot's ntfy page is offered on (`plugin/ntfy.py`). */
export const NTFY_FEATURE = "push_ntfy"

/** Each value's row, in the order and under the owner the page draws it. */
const GOTS_FIELDS: { id: NtfyField; title: string }[] = [{ id: "topic", title: "Topic" }]
const HERMES_FIELDS: { id: NtfyField; title: string }[] = [
  { id: "server", title: "Server URL" },
  { id: "token", title: "Auth token" },
]
const FIELDS = [...GOTS_FIELDS, ...HERMES_FIELDS]

/**
 * A bot's ntfy page: where its host publishes the news ntfy carries. The topic is Gots's own; the
 * server URL and the auth token are Hermes's `NTFY_SERVER_URL` and `NTFY_TOKEN`, the variables its own
 * ntfy platform reads, so the cards are captioned by who owns them. Each value is a row over the edit
 * that writes it; which phones are told is each phone's own switch, on its Notifications screen.
 */
export function NtfyTab({
  profile,
  sub,
  close,
  large,
}: {
  profile: Profile
  sub?: BotSub
  close: () => void
  large: boolean
}) {
  const navigate = useNavigate()
  const state = useNtfyTarget(profile)
  const [removing, setRemoving] = useState(false)
  const field = sub ? FIELDS.find((one) => one.id === sub.id) : undefined
  const edit = field && sub && (
    <NtfyEdit
      profile={profile}
      field={field.id}
      label={sub.label ?? field.title}
      state={state}
      large={large}
      close={close}
    />
  )
  // Below 1024px an edit is the screen the route pushed; from it, a card over the page.
  if (edit && !large) return edit
  const rows = (fields: typeof FIELDS) =>
    fields.map((one) => (
      <ValueRow
        key={one.id}
        title={one.title}
        value={state === undefined ? "…" : valueOf(state, one.id)}
        // The server Hermes uses by default is no value the profile set.
        muted={!state || (one.id === "server" && !state.server_set)}
        disabled={state === undefined}
        onClick={() => navigate(botSubPath(profile.id, "notifications", one.id))}
        data-ntfy-field={one.id}
      />
    ))
  return (
    <>
      <Caption>Gots</Caption>
      <Group>{rows(GOTS_FIELDS)}</Group>
      <Caption>Hermes</Caption>
      <Group>{rows(HERMES_FIELDS)}</Group>
      {state === null && (
        <p className="px-1 text-sm text-muted-foreground">This bot's host didn't answer.</p>
      )}
      {state?.topic && (
        <DestructiveButton onClick={() => setRemoving(true)}>Remove ntfy</DestructiveButton>
      )}
      <ConfirmDestructive
        open={removing}
        title="Remove ntfy?"
        description="This bot stops publishing to ntfy on every phone."
        confirmLabel="Remove"
        onOpenChange={setRemoving}
        onConfirm={() => clearNtfyTarget(profile)}
      />
      {edit && (
        <EditCard title={sub!.title} onClose={close}>
          {edit}
        </EditCard>
      )}
    </>
  )
}

function valueOf(state: NtfyState | null, field: NtfyField) {
  if (!state) return ""
  if (field === "token") return state.token_set ? "Set" : ""
  if (field === "server") return state.server ?? NTFY_DEFAULT_SERVER
  return state.topic ?? ""
}

/**
 * One value's edit. A topic not set yet starts from one nobody can guess and a server from the one
 * Hermes uses by default, whose Reset puts it back; a token is never shown, so its field starts empty
 * and only a new one is written.
 */
function NtfyEdit({
  profile,
  field,
  label,
  state,
  large,
  close,
}: {
  profile: Profile
  field: NtfyField
  label: string
  state: NtfyState | null | undefined
  large: boolean
  close: () => void
}) {
  const [topic] = useState(() =>
    mintTopic((count) => crypto.getRandomValues(new Uint8Array(count))),
  )
  const value =
    field === "server"
      ? (state?.server ?? NTFY_DEFAULT_SERVER)
      : field === "topic"
        ? (state?.topic ?? topic)
        : ""
  const held =
    field === "token" ? state?.token_set : field === "server" ? state?.server_set : !!state?.topic
  const save = async (next: string) => {
    await saveNtfyField(profile, field, next)
    close()
  }
  return (
    <EditForm
      label={label}
      value={value}
      kind={field === "token" ? "secret" : field === "server" ? "url" : "text"}
      placeholder={field === "token" ? "tk_… or user:pass" : undefined}
      surface={large ? "card" : "screen"}
      subject={`ntfy ${profile.id} ${field}`}
      // A value the host doesn't hold yet is worth saving as it stands: the default is a suggestion.
      saveable={(next) => (held ? next !== value : true) && FIELD_OK[field](next)}
      onSave={save}
      // A server the profile set goes back to the one Hermes uses by default.
      onReset={field === "server" && state?.server_set ? () => save("") : undefined}
      onCancel={close}
    />
  )
}

const FIELD_OK: Record<NtfyField, (value: string) => boolean> = {
  server: (value) => Boolean(ntfyServer(value)),
  topic: ntfyTopicOk,
  token: ntfyTokenOk,
}

import { useState } from "react"
import { EyeIcon, EyeOffIcon } from "lucide-react"

import { Refusal } from "@/components/banner"
import {
  EditCard,
  FormActions,
  fieldInnerClass,
  fieldLabelClass,
} from "@/components/settings-chrome"
import {
  InputGroup,
  InputGroupAddon,
  InputGroupButton,
  InputGroupInput,
} from "@/components/ui/input-group"
import type { Profile } from "@/lib/db"
import { clearNtfyTarget, saveNtfyTarget } from "@/lib/push"
import { NTFY_DEFAULT_SERVER, mintTopic, type NtfyState } from "@/lib/push-transport"
import { useRefusal } from "@/lib/use-refusal"

/**
 * One bot's ntfy target: the server, the topic and the access token its host publishes with. The
 * target is the bot's and lives on its host, so every phone reads it from there; this is where it is
 * written. A bot with none starts from the public server and a topic nobody can guess. The token is
 * never read back, so a bot that holds one shows the field empty and keeps it until a new one is typed.
 */
export function NtfyTargetCard({
  bot,
  label,
  state,
  onClose,
}: {
  bot: Profile
  label: string
  state: NtfyState | null | undefined
  onClose: () => void
}) {
  const held = state?.configured ? state : undefined
  const [server, setServer] = useState(held?.server ?? NTFY_DEFAULT_SERVER)
  const [topic, setTopic] = useState(
    () => held?.topic ?? mintTopic((count) => crypto.getRandomValues(new Uint8Array(count))),
  )
  const [token, setToken] = useState("")
  const [shown, setShown] = useState(false)
  const [busy, setBusy] = useState(false)
  const refusal = useRefusal(`ntfy ${bot.id}`)
  const write = (what: string, run: () => Promise<void>) => {
    setBusy(true)
    void refusal
      .write(what, async () => {
        await run()
        onClose()
      })
      .finally(() => setBusy(false))
  }
  return (
    <EditCard title={`ntfy for ${label}`} onClose={onClose}>
      <form
        className="flex flex-col gap-6"
        data-ntfy-form={bot.id}
        onSubmit={(event) => {
          event.preventDefault()
          write("save that", () => saveNtfyTarget(bot, { server, topic, token }))
        }}
      >
        <Field id="ntfy-server" label="Server">
          <InputGroupInput
            id="ntfy-server"
            className={fieldInnerClass}
            inputMode="url"
            autoComplete="off"
            autoCapitalize="off"
            autoCorrect="off"
            spellCheck={false}
            value={server}
            onChange={(event) => setServer(event.target.value)}
          />
        </Field>
        <Field id="ntfy-topic" label="Topic">
          <InputGroupInput
            id="ntfy-topic"
            className={fieldInnerClass}
            autoComplete="off"
            autoCapitalize="off"
            autoCorrect="off"
            spellCheck={false}
            value={topic}
            onChange={(event) => setTopic(event.target.value)}
          />
        </Field>
        <Field id="ntfy-token" label="Access token">
          <InputGroupInput
            id="ntfy-token"
            className={fieldInnerClass}
            autoComplete="off"
            autoCapitalize="off"
            autoCorrect="off"
            spellCheck={false}
            type={shown ? "text" : "password"}
            placeholder={held?.token_set ? "Set. Leave empty to keep it" : "tk_…"}
            value={token}
            onChange={(event) => setToken(event.target.value)}
          />
          <InputGroupAddon align="inline-end">
            <InputGroupButton
              size="icon-sm"
              className="mr-1 size-10 rounded-full"
              aria-label={shown ? "Hide token" : "Show token"}
              onClick={() => setShown((open) => !open)}
            >
              {shown ? <EyeOffIcon /> : <EyeIcon />}
            </InputGroupButton>
          </InputGroupAddon>
        </Field>
        <Refusal hold={refusal} />
        <FormActions
          onCancel={held ? undefined : onClose}
          onReset={held ? () => write("remove that", () => clearNtfyTarget(bot)) : undefined}
          resetLabel="Remove"
          destructive
          busy={busy}
        />
      </form>
    </EditCard>
  )
}

function Field({ id, label, children }: { id: string; label: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-2">
      <label htmlFor={id} className={fieldLabelClass}>
        {label}
      </label>
      <InputGroup className="h-12 rounded-full bg-muted">{children}</InputGroup>
    </div>
  )
}

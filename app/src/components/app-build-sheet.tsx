import { useEffect, useRef, useState } from "react"
import { useNavigate } from "react-router"
import { useLiveQuery } from "dexie-react-hooks"
import { CircleAlertIcon } from "lucide-react"

import { Popup, PopupContent, PopupHeader, PopupTitle } from "@/components/popup"
import { Button } from "@/components/ui/button"
import { Field, FieldLabel } from "@/components/ui/field"
import { Spinner } from "@/components/ui/spinner"
import { Textarea } from "@/components/ui/textarea"
import { buildBlocked, consentOf, titleOf } from "@/lib/app-build"
import { buildPages, saveApp } from "@/lib/apps"
import { getActiveProfile } from "@/lib/db"
import { usePluginFeature } from "@/lib/features"
import { useHostRecord } from "@/lib/host-record"
import { OPENUI_SWITCH, UNANSWERED_IS_ON } from "@/lib/openui-switch"

const reasonOf = (error: unknown) =>
  error instanceof Error && error.message ? error.message : "Couldn't build the app."

type Step =
  | { kind: "prompt"; error?: string }
  | { kind: "building" }
  | { kind: "consent"; pages: string[] }
  | { kind: "saving"; pages: string[] }

/**
 * Asks for an app: what it should be, then the build, then the list of tools its pages call. The
 * app is written only when that list is agreed to; closing or declining at any step writes nothing.
 */
export function AppBuildSheet({
  open,
  onOpenChange,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
}) {
  const profile = useLiveQuery(async () => (await getActiveProfile()) ?? null, [])
  const apps = usePluginFeature(profile, "apps")
  const { value: interfaces, settled } = useHostRecord(profile, OPENUI_SWITCH, UNANSWERED_IS_ON)
  const blocked = buildBlocked(apps, settled ? interfaces : undefined)
  const navigate = useNavigate()
  const [prompt, setPrompt] = useState("")
  const [step, setStep] = useState<Step>({ kind: "prompt" })
  const running = useRef<AbortController>(undefined)

  useEffect(() => () => running.current?.abort(), [])

  const close = (next: boolean) => {
    if (next) return onOpenChange(true)
    running.current?.abort()
    running.current = undefined
    setStep({ kind: "prompt" })
    setPrompt("")
    onOpenChange(false)
  }

  const build = async () => {
    if (!profile || !prompt.trim()) return
    const controller = new AbortController()
    running.current = controller
    setStep({ kind: "building" })
    try {
      const pages = await buildPages(profile, prompt, controller.signal)
      if (!controller.signal.aborted) setStep({ kind: "consent", pages })
    } catch (error) {
      if (!controller.signal.aborted) setStep({ kind: "prompt", error: reasonOf(error) })
    }
  }

  const save = async (pages: string[]) => {
    if (!profile) return
    setStep({ kind: "saving", pages })
    try {
      const app = await saveApp(profile, titleOf(prompt), pages)
      close(false)
      navigate(`/apps/${app.id}`)
    } catch (error) {
      setStep({ kind: "prompt", error: reasonOf(error) })
    }
  }

  return (
    <Popup open={open} onOpenChange={close}>
      <PopupContent className="max-h-[90dvh]" dataSlot="app-build">
        <PopupHeader className="pb-2">
          <PopupTitle>
            {step.kind === "consent" || step.kind === "saving" ? "What it may use" : "New app"}
          </PopupTitle>
        </PopupHeader>
        {(step.kind === "prompt" || step.kind === "building") && (
          <form
            className="flex flex-col gap-4 px-6 pb-6"
            onSubmit={(event) => {
              event.preventDefault()
              void build()
            }}
          >
            <Field>
              <FieldLabel htmlFor="app-prompt">What should it be?</FieldLabel>
              <Textarea
                id="app-prompt"
                rows={4}
                placeholder="A dashboard of my rooms, with a page for each"
                disabled={step.kind === "building"}
                value={prompt}
                onChange={(event) => setPrompt(event.target.value)}
              />
            </Field>
            {step.kind === "prompt" && step.error && (
              <p className="flex items-start gap-2 text-sm text-destructive" role="alert">
                <CircleAlertIcon className="mt-0.5 size-4 shrink-0" />
                <span className="min-w-0 break-words">{step.error}</span>
              </p>
            )}
            {blocked && <p className="text-sm text-muted-foreground">{blocked}</p>}
            <Button
              type="submit"
              className="h-11"
              disabled={Boolean(blocked) || !prompt.trim() || step.kind === "building"}
            >
              {step.kind === "building" ? (
                <>
                  <Spinner className="size-4" /> Building…
                </>
              ) : (
                "Build"
              )}
            </Button>
          </form>
        )}
        {(step.kind === "consent" || step.kind === "saving") && (
          <Consent
            pages={step.pages}
            saving={step.kind === "saving"}
            onAgree={() => void save(step.pages)}
            onDecline={() => close(false)}
          />
        )}
      </PopupContent>
    </Popup>
  )
}

function Consent({
  pages,
  saving,
  onAgree,
  onDecline,
}: {
  pages: string[]
  saving: boolean
  onAgree: () => void
  onDecline: () => void
}) {
  const { reads, acts } = consentOf(pages)
  const none = reads.length === 0 && acts.length === 0
  return (
    <div className="flex flex-col gap-4 px-6 pb-6">
      {none ? (
        <p className="text-sm text-muted-foreground">
          This app calls no tools. It only shows what its pages hold.
        </p>
      ) : (
        <>
          <ToolList label="It can read" tools={reads} />
          <ToolList label="It can act on" tools={acts} />
        </>
      )}
      <div className="flex flex-col gap-2">
        <Button className="h-11" disabled={saving} onClick={onAgree}>
          {saving ? <Spinner className="size-4" /> : null} Save app
        </Button>
        <Button variant="outline" className="h-11" disabled={saving} onClick={onDecline}>
          Decline
        </Button>
      </div>
    </div>
  )
}

function ToolList({ label, tools }: { label: string; tools: string[] }) {
  if (tools.length === 0) return null
  return (
    <section aria-label={label} className="flex flex-col gap-1">
      <h3 className="text-sm font-medium">{label}</h3>
      <ul className="flex flex-col gap-1 text-sm text-muted-foreground">
        {tools.map((tool) => (
          <li key={tool}>{tool}</li>
        ))}
      </ul>
    </section>
  )
}

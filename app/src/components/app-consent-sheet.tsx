import { useState } from "react"
import { CircleAlertIcon } from "lucide-react"

import { Popup, PopupContent, PopupHeader, PopupTitle } from "@/components/popup"
import { Button } from "@/components/ui/button"
import { ToolList } from "@/components/tool-list"
import { Spinner } from "@/components/ui/spinner"
import { agreeToTools, useActiveProfile } from "@/lib/apps"
import type { HostAppTools } from "@/lib/hermes"

/**
 * Asks again where an app's pages came to name tools it was never agreed to, showing only those.
 * Until they are agreed to the host refuses each call, so declining leaves the page drawing refusals.
 */
export function AppConsentSheet({ appId, pending }: { appId: string; pending: HostAppTools }) {
  const profile = useActiveProfile()
  const waiting = pending.reads.length + pending.acts.length > 0
  const [declined, setDeclined] = useState<string>()
  const [saving, setSaving] = useState(false)
  const [failure, setFailure] = useState<string>()
  const asked = JSON.stringify(pending)
  const agree = async () => {
    if (!profile) return
    setSaving(true)
    setFailure(undefined)
    try {
      await agreeToTools(profile, appId, pending)
    } catch (error) {
      setFailure(error instanceof Error && error.message ? error.message : "Couldn't save that.")
    } finally {
      setSaving(false)
    }
  }
  return (
    <Popup open={waiting && declined !== asked} onOpenChange={(open) => open || setDeclined(asked)}>
      <PopupContent className="max-h-[90dvh]" dataSlot="app-consent">
        <PopupHeader className="pb-2">
          <PopupTitle>It now asks for more</PopupTitle>
        </PopupHeader>
        <div className="flex flex-col gap-4 px-6 pb-6">
          <ToolList label="It can also read" tools={pending.reads} />
          <ToolList label="It can also act on" tools={pending.acts} />
          {failure && (
            <p className="flex items-start gap-2 text-sm text-destructive" role="alert">
              <CircleAlertIcon className="mt-0.5 size-4 shrink-0" />
              <span className="min-w-0 break-words">{failure}</span>
            </p>
          )}
          <div className="flex flex-col gap-2">
            <Button className="h-11" disabled={saving} onClick={() => void agree()}>
              {saving ? <Spinner className="size-4" /> : null} Allow
            </Button>
            <Button
              variant="outline"
              className="h-11"
              disabled={saving}
              onClick={() => setDeclined(asked)}
            >
              Not now
            </Button>
          </div>
        </div>
      </PopupContent>
    </Popup>
  )
}

/**
 * A project's Prompt, written: how its AFK work is carried out. Its own bottom sheet — the app's own
 * pop-up, so a drawer from a laptop's width — with the words in a field deep enough to read them in.
 * Done writes it and closes on the host's answer; the sheet's own way out leaves the words unwritten,
 * and a refused write is said by the caller, which is why the draft stays as typed.
 */
import { useState } from "react"

import { Popup, PopupContent, PopupHeader, PopupTitle } from "@/components/popup"
import { Button } from "@/components/ui/button"
import { Textarea } from "@/components/ui/textarea"

export function PromptEditor({
  open,
  onOpenChange,
  prompt,
  onSave,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  /** The words the row holds, which the host answers as the default where the project wrote none. */
  prompt: string
  /** Writes the Prompt, answering whether the host took it; a refusal has already been said. */
  onSave: (prompt: string) => Promise<boolean>
}) {
  // The draft is the editor's own: the sheet is keyed by its open state, so each open starts from the
  // words the row holds rather than from the last thing typed into it.
  const [text, setText] = useState(prompt)
  const [saving, setSaving] = useState(false)

  const submit = async () => {
    setSaving(true)
    try {
      if (await onSave(text)) onOpenChange(false)
    } finally {
      setSaving(false)
    }
  }

  return (
    <Popup open={open} onOpenChange={onOpenChange}>
      <PopupContent>
        <PopupHeader>
          <PopupTitle>Prompt</PopupTitle>
        </PopupHeader>
        <div className="flex min-h-0 flex-1 flex-col gap-3 px-4 pb-4 sm:px-6">
          <Textarea
            aria-label="Prompt"
            placeholder="How this project's work is carried out"
            className="min-h-[38dvh] resize-none rounded-2xl px-4 py-3 text-base md:text-[15px]"
            value={text}
            onChange={(event) => setText(event.target.value)}
          />
          <Button
            className="h-11 shrink-0 self-end rounded-full px-5"
            disabled={saving}
            onClick={() => void submit()}
          >
            Done
          </Button>
        </div>
      </PopupContent>
    </Popup>
  )
}

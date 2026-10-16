import { CpuIcon } from "lucide-react"

import { shortModel } from "@/lib/model-info"

/**
 * Where a chat's model changed, between the turns either side of it: a hairline broken by a pill
 * naming the model that took over. A label, not a control — the pill under the composer is where a
 * model is picked — so it takes no touch target of its own.
 */
export function ModelChange({ model }: { model: string }) {
  return (
    <div
      role="separator"
      aria-label={`Model switched to ${model}`}
      className="flex items-center gap-3 py-1"
    >
      <div className="h-px flex-1 bg-border" />
      <div className="flex items-center gap-1.5 rounded-full bg-muted/60 px-3 py-1 text-xs text-muted-foreground">
        <CpuIcon className="size-3.5" />
        {shortModel(model)}
      </div>
      <div className="h-px flex-1 bg-border" />
    </div>
  )
}

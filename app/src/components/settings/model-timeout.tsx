import { Segmented } from "@/components/segmented"
import { RowText, rowClass, useScreenRefusal } from "@/components/settings-chrome"
import type { Profile } from "@/lib/db"
import { usePluginFeature } from "@/lib/features"
import { MODEL_TIMEOUT, timeoutOptions, useModelTimeout } from "@/lib/model-timeout"
import { cn } from "@/lib/utils"

/**
 * One bot's model-call timeout, set where the other Developer controls are: the longest a research
 * or meeting model call may take on its host. The host holds it, so a write it refuses is shown in
 * its words and the control keeps what the host says; a bot whose plugin predates it says so.
 */
export function ModelTimeoutRow({ bot, title }: { bot: Profile; title: string }) {
  const answer = usePluginFeature(bot, MODEL_TIMEOUT.feature)
  const { value, settled, supported, saving, save } = useModelTimeout(bot)
  const refusal = useScreenRefusal()
  const offered = answer === "yes" && supported

  return (
    <div
      className={cn(rowClass, "flex-col items-stretch gap-3")}
      aria-busy={saving || undefined}
      data-setting="model-timeout"
    >
      <RowText
        title={title}
        subtitle={
          answer === "no"
            ? "Not available on this bot's host"
            : "Longest a research or meeting model call may take"
        }
      />
      <Segmented
        label={`Model call timeout, ${title}`}
        options={timeoutOptions(value)}
        value={value}
        onChange={(next) => void refusal.write("save that timeout", () => save(next))}
        disabled={!offered || !settled || saving}
      />
    </div>
  )
}

import { useLiveQuery } from "dexie-react-hooks"

import { getSettings } from "@/lib/db"
import { usePluginFeatureOn, type PluginServer } from "@/lib/features"
import { AFK_PIPELINE_FEATURE, type SessionPipeline } from "@/lib/pipeline"

/**
 * Whether AFK Workflows is on: the device's own switch under Developer, which the plugin has no
 * part in. Everything the switch holds back reads it here, so none of it can drift from another.
 */
export function useAfkWorkflowsOn() {
  return Boolean(
    useLiveQuery(async () => {
      const settings = await getSettings()
      return Boolean(settings.developer && settings.afkWorkflows)
    }, []),
  )
}

/**
 * The pipeline a session draws, or nothing: the record it holds, where the bot's plugin stages
 * tasks and the switch is on. The pill and the sheet both take this, so they can't disagree.
 */
export function useStagedPipeline(server: PluginServer, pipeline: SessionPipeline | null | undefined) {
  const on = useAfkWorkflowsOn()
  const staged = usePluginFeatureOn(pipeline ? server : null, AFK_PIPELINE_FEATURE)
  return on && staged && pipeline ? pipeline : null
}

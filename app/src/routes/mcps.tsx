import { useCallback, useEffect, useState } from "react"
import { useLiveQuery } from "dexie-react-hooks"
import { ArrowLeftIcon, ServerIcon } from "lucide-react"
import { Navigate, useParams } from "react-router"
import { toast } from "sonner"

import { Group, rowClass, Screen } from "@/components/settings-chrome"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Switch } from "@/components/ui/switch"
import { listProfiles } from "@/lib/db"
import { useMcpFeatureAnswers, useMcpServers, MCP_STATE_WORDS } from "@/lib/mcps"
import type { McpServer, McpState } from "@/lib/hermes"
import { setBackGuard } from "@/lib/native"
import { useNav } from "@/lib/nav"

/** How loud each state reads: a failed server is the only one that is a problem. */
const STATE_TONES: Record<McpState, "secondary" | "outline" | "destructive"> = {
  on: "secondary",
  off: "outline",
  connecting: "outline",
  failed: "destructive",
  needs_access: "outline",
  plugin: "outline",
}

/**
 * A Bot's MCP servers: every one the Bot's Hermes profile has, each with the state it is in, and a
 * switch that turns one on or off for that Bot wherever the plugin can write one. A server a Hermes
 * plugin provides is read as what it is and carries no switch, because Hermes refuses to modify one,
 * and a Host that can list servers without being able to change them has no switch either rather
 * than one that can only fail. Reached from the Bot's own row in Settings and by URL; back returns
 * to the Bot. A Bot whose Hermes can't list them has no screen at all, so its URL sends the user
 * back to the Bot, while one whose Host hasn't answered yet draws nothing rather than flashing its
 * screen away.
 */
export function McpsPage() {
  const { botId } = useParams()
  const { up } = useNav()
  const profiles = useLiveQuery(listProfiles, [])
  const profile = profiles?.find((p) => p.id === botId)
  const { list, write } = useMcpFeatureAnswers(profile)
  const { servers, setEnabled } = useMcpServers(profile, list === "yes")
  const profileId = profile?.id
  // Android's back does what the header's button does: it returns to the Bot.
  const back = useCallback(
    () => up(profileId ? `/settings/bots/${profileId}` : "/settings"),
    [up, profileId],
  )
  useEffect(() => setBackGuard(() => (back(), true)), [back])

  if (profiles === undefined) return null
  if (!profile) return <Navigate to="/settings" replace />
  // The plugin answered without the feature: there is nothing to list, so a hand-typed URL lands
  // back on the Bot rather than on a blank screen with no way out.
  if (list === "no") return <Navigate to={`/settings/bots/${profile.id}`} replace />
  // Still unanswered: nothing is drawn, so a good Bot's screen doesn't flash away on a direct visit.
  if (list !== "yes") return null

  return (
    <Screen
      title="MCP servers"
      leading={
        <Button
          variant="outline"
          size="icon-lg"
          className="size-11 rounded-full"
          onClick={() => up(`/settings/bots/${profile.id}`)}
          aria-label="Back"
        >
          <ArrowLeftIcon />
        </Button>
      }
    >
      {servers === undefined ? null : servers.length === 0 ? (
        <p className="px-1 text-sm text-muted-foreground">No MCP servers.</p>
      ) : (
        <Group>
          {servers.map((server) => (
            <ServerRow
              key={server.name}
              server={server}
              writable={write === "yes"}
              onToggle={setEnabled}
            />
          ))}
        </Group>
      )}
    </Screen>
  )
}

/**
 * One server: its name, the Host's own reason when it failed, Gots' word for its state, and its
 * switch wherever the Bot's Host can write one. The switch follows the server's own on/off flag
 * rather than the state word, which folds several of the Host's states into "on".
 */
function ServerRow({
  server,
  writable,
  onToggle,
}: {
  server: McpServer
  writable: boolean
  onToggle: (name: string, enabled: boolean) => Promise<void>
}) {
  const [saving, setSaving] = useState(false)
  return (
    <div className={rowClass} data-mcp={server.name}>
      <ServerIcon className="size-5 shrink-0 text-muted-foreground" />
      <span className="flex min-w-0 flex-1 flex-col">
        <span className="truncate text-base">{server.name}</span>
        {server.reason && <span className="text-sm text-destructive">{server.reason}</span>}
      </span>
      <Badge variant={STATE_TONES[server.state]}>{MCP_STATE_WORDS[server.state]}</Badge>
      {/* No switch for a server a Hermes plugin provides (Hermes refuses to modify one), nor for a
          Host that can't write — the state word says what it is either way. */}
      {server.source === "config" && writable && (
        <Switch
          aria-label={server.name}
          checked={server.enabled}
          disabled={saving}
          onCheckedChange={async (checked) => {
            setSaving(true)
            try {
              await onToggle(server.name, checked)
            } catch (error) {
              toast.error(error instanceof Error ? error.message : "Couldn't save that.")
            } finally {
              setSaving(false)
            }
          }}
        />
      )}
    </div>
  )
}

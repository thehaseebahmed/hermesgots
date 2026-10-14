import { useState } from "react"

import { Group } from "@/components/group"
import { PR_GROUPS } from "@/components/chat/pr-look"
import { PrRow } from "@/components/chat/pr-pill"
import { SessionLibrary } from "@/components/library"
import { Popup, PopupContent, PopupHeader, PopupTitle } from "@/components/popup"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import type { Conversation } from "@/lib/db"
import type { HermesConfig } from "@/lib/hermes"

/**
 * A session's outputs as a drawer above the composer: every pull request it has — the live ones
 * first, the finished ones folded into their own group — and the files it filed, as the project's
 * Library shows them but only for this session. Opened by the outputs pill, or the PR pill.
 */
export function OutputsDrawer({
  open,
  onOpenChange,
  session,
  config,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  session: Conversation
  config: HermesConfig
}) {
  const prs = [...(session.prs ?? [])].sort(
    (a, b) => b.number - a.number || a.repo.localeCompare(b.repo),
  )
  // A session with pull requests opens on them; one with only files opens on the files.
  const [tab, setTab] = useState(prs.length ? "prs" : "library")
  return (
    <Popup side open={open} onOpenChange={onOpenChange}>
      <PopupContent>
        <PopupHeader className="pb-2">
          <PopupTitle>Outputs</PopupTitle>
        </PopupHeader>
        <Tabs value={tab} onValueChange={setTab}>
          <div className="px-3 sm:px-4">
            <TabsList>
              <TabsTrigger value="prs">PRs</TabsTrigger>
              <TabsTrigger value="library">Library</TabsTrigger>
            </TabsList>
          </div>
          <TabsContent value="prs" className="px-3 pb-4 sm:px-4">
            {prs.length === 0 ? (
              <p className="py-8 text-center text-sm text-muted-foreground">
                No pull requests yet.
              </p>
            ) : (
              <div className="flex flex-col gap-6 pt-4">
                {PR_GROUPS.map((group) => {
                  const list = prs.filter((pr) => group.states.includes(pr.state))
                  if (!list.length) return null
                  return (
                    <Group
                      key={group.label}
                      label={group.label}
                      count={list.length}
                      fold={group.fold}
                    >
                      {list.map((pr) => (
                        <li key={`${pr.repo}#${pr.number}`}>
                          <PrRow pr={pr} />
                        </li>
                      ))}
                    </Group>
                  )
                })}
              </div>
            )}
          </TabsContent>
          <TabsContent value="library">
            <SessionLibrary
              config={config}
              sessionId={session.hermesSessionId}
              branch={session.worktree?.branch}
              title={session.title}
              active={open && tab === "library"}
            />
          </TabsContent>
        </Tabs>
      </PopupContent>
    </Popup>
  )
}

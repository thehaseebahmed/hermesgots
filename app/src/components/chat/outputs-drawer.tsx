import { useEffect, useMemo, useRef, useState } from "react"

import { PrRow } from "@/components/chat/pr-pill"
import { SessionLibrary } from "@/components/library"
import { Popup, PopupContent, PopupHeader, PopupTitle } from "@/components/popup"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { byNewestPr, prKey, type Conversation } from "@/lib/db"
import type { HermesConfig } from "@/lib/hermes"

/**
 * A session's outputs as a drawer above the composer: every pull request it has, newest first as one
 * list, and the files it filed, as the project's Library shows them but only for this session.
 * Opened by the pill above the composer.
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
  const prs = useMemo(() => [...(session.prs ?? [])].sort(byNewestPr), [session.prs])
  // A session with pull requests opens on them; one with only files opens on the files. Set on each
  // opening too: the drawer stays mounted between them, and its list only reaches the app later.
  const [tab, setTab] = useState(prs.length ? "prs" : "library")
  const wasOpen = useRef(open)
  useEffect(() => {
    if (open && !wasOpen.current) setTab(prs.length ? "prs" : "library")
    wasOpen.current = open
  }, [open, prs.length])
  return (
    <Popup open={open} onOpenChange={onOpenChange}>
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
              <ul className="pt-2">
                {prs.map((pr) => (
                  <li key={prKey(pr)}>
                    <PrRow pr={pr} />
                  </li>
                ))}
              </ul>
            )}
          </TabsContent>
          <TabsContent value="library">
            <SessionLibrary
              config={config}
              sessionId={session.hermesSessionId}
              active={open && tab === "library"}
            />
          </TabsContent>
        </Tabs>
      </PopupContent>
    </Popup>
  )
}

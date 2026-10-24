import { useEffect, useState } from "react"

import { Popup, PopupContent, PopupHeader, PopupTitle } from "@/components/popup"
import { cheatsheetGroups } from "@/lib/cheatsheet"
import { DEFAULT_SETTINGS, getSettings } from "@/lib/db"

/**
 * The keys a hardware keyboard answers in Gots, one group at a time: an unanchored pop-up, so it is
 * a bottom sheet on a phone and a drawer from 1024px, with the header pinned above one scroll
 * region (ADR 0035, ADR 0042).
 *
 * The Navigation group obeys the synced Appearance switch, read once each time the sheet opens and
 * never written back: a switch flipped while the sheet is up shows the next time it is opened.
 */
export function Cheatsheet({
  open,
  onOpenChange,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
}) {
  const [navShortcuts, setNavShortcuts] = useState(DEFAULT_SETTINGS.navShortcuts)
  useEffect(() => {
    if (!open) return
    let current = true
    void getSettings().then((settings) => {
      if (current) setNavShortcuts(settings.navShortcuts ?? DEFAULT_SETTINGS.navShortcuts)
    })
    return () => {
      current = false
    }
  }, [open])

  return (
    <Popup open={open} onOpenChange={onOpenChange}>
      <PopupContent size="md">
        <PopupHeader className="pb-2">
          <PopupTitle>Cheatsheet</PopupTitle>
        </PopupHeader>
        <div className="flex flex-col gap-5 px-6 pt-2 pb-6">
          {cheatsheetGroups(navShortcuts).map((group) => (
            <section key={group.name} data-group={group.name} className="flex flex-col gap-1">
              <h3 className="text-xs font-medium text-muted-foreground">{group.name}</h3>
              <dl className="flex flex-col">
                {group.rows.map((row) => (
                  <div
                    key={row.description}
                    className="flex items-center justify-between gap-4 py-2"
                  >
                    <dt className="text-sm text-foreground">{row.description}</dt>
                    <dd className="flex shrink-0 items-center gap-1">
                      {row.keys.map((key, index) => (
                        <kbd
                          key={`${key}-${index}`}
                          className="rounded-md bg-muted px-1.5 py-0.5 font-mono text-xs text-muted-foreground"
                        >
                          {key}
                        </kbd>
                      ))}
                    </dd>
                  </div>
                ))}
              </dl>
            </section>
          ))}
        </div>
      </PopupContent>
    </Popup>
  )
}

import { useState } from "react"

import { Popup, PopupContent, PopupHeader, PopupTitle } from "@/components/popup"
import { cheatsheetGroups, type CheatsheetSwitches } from "@/lib/cheatsheet"
import { DEFAULT_SETTINGS, getSettings } from "@/lib/db"
import { quietly } from "@/lib/report"

const SHIPPED: CheatsheetSwitches = {
  navShortcuts: DEFAULT_SETTINGS.navShortcuts,
  sendOnEnter: DEFAULT_SETTINGS.sendOnEnter,
}

/**
 * The sheet's state and the switches it was opened under. Read once as it opens and held, never a
 * live binding (ADR 0042), so a switch flipped while the sheet is up shows on the next opening.
 */
export function useCheatsheet() {
  const [switches, setSwitches] = useState<CheatsheetSwitches>(SHIPPED)
  const [open, setOpen] = useState(false)
  const show = async () => {
    const read = await getSettings().catch(quietly("Reading the cheatsheet's switches"))
    setSwitches({
      navShortcuts: read?.navShortcuts ?? DEFAULT_SETTINGS.navShortcuts,
      sendOnEnter: read?.sendOnEnter ?? DEFAULT_SETTINGS.sendOnEnter,
    })
    setOpen(true)
  }
  return { open, setOpen, show, switches }
}

/**
 * The keys a hardware keyboard answers in Gots, one group at a time: an unanchored pop-up, so it is
 * a bottom sheet on a phone and a drawer from 1024px, with the header pinned above one scroll
 * region (ADR 0035, ADR 0042). `switches` comes from `useCheatsheet`, frozen when it opened.
 */
export function Cheatsheet({
  open,
  onOpenChange,
  switches,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  switches: CheatsheetSwitches
}) {
  return (
    <Popup open={open} onOpenChange={onOpenChange}>
      <PopupContent size="md">
        <PopupHeader className="pb-2">
          <PopupTitle>Cheatsheet</PopupTitle>
        </PopupHeader>
        <div className="flex flex-col gap-5 px-6 pt-2 pb-6">
          {cheatsheetGroups(switches).map((group) => (
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

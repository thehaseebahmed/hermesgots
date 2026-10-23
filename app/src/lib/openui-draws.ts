/**
 * What each row of a thread draws as an interface, keyed by the row's id. The fold lives behind a
 * dynamic import — the module statically holds the Lang parser, and the chat route is on the
 * startup path — and is asked for only once a row really carries a block, so a thread with no
 * interface in it never pays for it.
 *
 * This is the one place that decides whether a block draws at all.
 */
import { useEffect, useMemo, useState } from "react"

import { OPENUI_ROOT } from "@/components/openui/root.ts"
import type { PluginServer } from "@/lib/features.ts"
import { useHostRecord } from "@/lib/host-record"
import { mayCarryBlock } from "@/lib/openui-block.ts"
import { OPENUI_SWITCH, UNANSWERED_IS_ON } from "@/lib/openui-switch"
import { quietly } from "@/lib/report"

import type { ThreadBlock, ThreadRow } from "./openui-thread.ts"

type Fold = typeof import("./openui-thread.ts").resolveInterfaces

const EMPTY: Map<string, ThreadBlock[]> = new Map()

export function useDraws(rows: ThreadRow[], server?: PluginServer): Map<string, ThreadBlock[]> {
  const carries = useMemo(
    () => rows.some((row) => row.role === "assistant" && mayCarryBlock(row.content)),
    [rows],
  )
  const { value: on, settled } = useHostRecord(
    carries ? server : null,
    OPENUI_SWITCH,
    UNANSWERED_IS_ON,
  )
  const [fold, setFold] = useState<Fold>()
  useEffect(() => {
    if (fold || !carries || !settled || !on) return
    void import("./openui-thread.ts").then(
      (module) => setFold(() => module.resolveInterfaces),
      quietly("the interface fold"),
    )
  }, [carries, settled, on, fold])
  return useMemo(
    () => (fold && settled && on ? fold(rows, OPENUI_ROOT) : EMPTY),
    [fold, settled, on, rows],
  )
}

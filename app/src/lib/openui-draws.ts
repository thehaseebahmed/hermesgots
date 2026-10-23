/**
 * What each row of a thread draws as an interface, keyed by the row's id. The fold lives behind a
 * dynamic import — the module statically holds the Lang parser, and the chat route is on the
 * startup path — and is asked for only once a row really carries a block, so a thread with no
 * interface in it never pays for it.
 *
 * This is also the one place that decides whether a block draws at all: the profile's switch is
 * read here, and while it is off the map is empty, so every block stays the text it arrived as and
 * the markdown renderer draws the fence as the code the model sent. Nothing else in the thread
 * consults the switch (ADR 0033).
 */
import { useEffect, useMemo, useState } from "react"

import { OPENUI_ROOT } from "@/components/openui/root.ts"
import type { PluginServer } from "@/lib/features.ts"
import { useHostRecord } from "@/lib/host-record"
import { mayCarryBlock } from "@/lib/openui-block.ts"
import { OPENUI_SWITCH } from "@/lib/openui-switch"
import { quietly } from "@/lib/report"

import type { ThreadBlock, ThreadRow } from "./openui-thread.ts"

type Fold = typeof import("./openui-thread.ts").resolveInterfaces

const EMPTY: Map<string, ThreadBlock[]> = new Map()

export function useDraws(rows: ThreadRow[], server?: PluginServer): Map<string, ThreadBlock[]> {
  const carries = useMemo(
    () => rows.some((row) => row.role === "assistant" && mayCarryBlock(row.content)),
    [rows],
  )
  // A thread with no interface never asks the host anything, so the switch is read only where a
  // block could draw. An unread or unanswerable switch is `true`: the app draws as it always did,
  // and only a host that says off stops it.
  const { value: on } = useHostRecord(carries ? server : null, OPENUI_SWITCH, true)
  const [fold, setFold] = useState<Fold>()
  useEffect(() => {
    if (fold || !carries || !on) return
    void import("./openui-thread.ts").then(
      (module) => setFold(() => module.resolveInterfaces),
      quietly("the interface fold"),
    )
  }, [carries, on, fold])
  return useMemo(() => (fold && on ? fold(rows, OPENUI_ROOT) : EMPTY), [fold, on, rows])
}

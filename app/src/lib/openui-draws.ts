/**
 * What each row of a thread draws as an interface, keyed by the row's id. The fold lives behind a
 * dynamic import — the module statically holds the Lang parser, and the chat route is on the
 * startup path — and is asked for only once a row really carries a block, so a thread with no
 * interface in it never pays for it.
 */
import { useEffect, useMemo, useState } from "react"

import { OPENUI_ROOT } from "@/components/openui/root.ts"
import { carriesBlock } from "@/lib/openui-block.ts"
import { quietly } from "@/lib/report"

import type { ThreadBlock, ThreadRow } from "./openui-thread.ts"

type Fold = typeof import("./openui-thread.ts").resolveInterfaces

/** What the hook answers until the fold's chunk lands: nothing draws yet. */
const EMPTY: Map<string, ThreadBlock[]> = new Map()

export function useDraws(rows: ThreadRow[]): Map<string, ThreadBlock[]> {
  const [fold, setFold] = useState<Fold>()
  useEffect(() => {
    if (fold) return
    // The fold reads assistant rows alone, so only those may ask for its module.
    if (!rows.some((row) => row.role === "assistant" && carriesBlock(row.content))) return
    void import("./openui-thread.ts").then(
      (module) => setFold(() => module.resolveInterfaces),
      quietly("the interface fold"),
    )
  }, [rows, fold])
  return useMemo(() => (fold ? fold(rows, OPENUI_ROOT) : EMPTY), [fold, rows])
}

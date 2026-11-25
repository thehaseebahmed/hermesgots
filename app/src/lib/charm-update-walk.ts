/**
 * The one walk a firmware update screen may run at a time, held outside the screen that draws
 * it: the send is driven by its own promise, not by the screen, so the walk's own state — its
 * running flag, its progress, its end — has to outlive the screen too. A reader who steps back
 * mid-walk and returns joins the walk in flight on the screen they come back to; no second
 * update is started beside the first.
 *
 * The shapes here are the walk's own: the steps it draws, the hand it sends, and the state they
 * move — everything the screen adds on top (its titles, its bars, its picker) stays with the
 * screen. The state is module-level on purpose: one charm, one walk at a time, for as long as
 * the app holds the screen's route.
 */
import { useSyncExternalStore } from "react"

import type { CharmScheme } from "./charm.ts"

/** One step of the walk: its line, and its bar while it moves. */
export interface StepView {
  name: "download" | "transfer" | "restart"
  subtitle?: string
  percent?: number
}

/**
 * One image's way onto the charm: the bytes this phone sends over the link, or the door the
 * charm walks itself — the URL this phone hands it, and the hash the bytes it fetches must
 * carry. The `door` names where the hand came from, which is how the walk's end gate reads:
 * the published package names a build newer than the charm's own, so its end waits on the
 * version changing, while a reader's file names none — an unchanged version is the charm back
 * on the build it was sent.
 */
export type FirmwareHand =
  | { kind: "transfer"; image: Uint8Array; sha256Hex: string; door: "published" | "file" }
  | {
      kind: "fetch"
      url: string
      sha256Hex: string
      scheme: CharmScheme
      door: "published"
    }

/** The one walk at a time, as every mount of the update screen shares it. */
interface WalkState {
  /** Whether a walk is running now: the one flag a second send defers to. */
  running: boolean
  title: string | null
  note: string | null
  steps: StepView[]
  end:
    | {
        kind: "done"
        /** The build the charm came back on, as its own answer read it. */
        version: string
        /** The build the walk started on, read before anything went; null where the charm could not say. */
        was: string | null
      }
    | { kind: "failed"; said: string }
    | null
  /** The last hand, in the words it went under: what a failure's Try again re-runs. */
  again: { hand: (was: string | null) => Promise<FirmwareHand>; title: string } | null
  /**
   * The published version this visit's walk was started for: a later visit joins the walk it
   * names rather than starting one beside it, while a visit whose offer names a new version —
   * the host published again — is a new ask, and starts its own.
   */
  started: string | null
}

/** No walk at all: where a fresh load starts, and where a test puts the shared walk back. */
const NO_WALK: WalkState = {
  running: false,
  title: null,
  note: null,
  steps: [],
  end: null,
  again: null,
  started: null,
}

/**
 * The shared walk itself — a live binding, so a screen reads what the send last wrote even
 * between the redraws its subscription draws.
 */
export let walk: WalkState = NO_WALK
const walkers = new Set<() => void>()

/** One change to the shared walk, drawn by every screen that holds it. */
export const setWalk = (patch: Partial<WalkState>) => {
  walk = { ...walk, ...patch }
  for (const drawn of walkers) drawn()
}

/** The shared walk as this screen draws it, redrawing as the send moves it on. */
export const useWalk = () =>
  useSyncExternalStore(
    (drawn) => {
      walkers.add(drawn)
      return () => walkers.delete(drawn)
    },
    () => walk,
  )

/** The shared walk put back to none — a test's screens each start where a fresh load would. */
export function resetCharmUpdateWalk() {
  setWalk(NO_WALK)
}

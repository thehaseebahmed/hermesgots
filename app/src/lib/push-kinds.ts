/**
 * What a push can be about, and which of it a device wants. A push has a kind (`plugin/push.py`
 * and `netlify/lib/fcm.ts` keep the same list); the user picks by category, since the three that
 * wait on them read as one. Each category is an Android notification channel of its own (so
 * Android's settings can turn it off too) and a switch in Settings.
 */

export type PushCategory =
  | "sessions"
  | "theseus"
  | "run_failed"
  | "run_done"
  | "pr_checks"
  | "pr_merged"
  | "clone_failed"
  | "routine_failed"

export interface PushCategoryInfo {
  id: PushCategory
  title: string
  kinds: string[]
  /** On until the user turns it off; the quieter kinds start off. */
  on: boolean
  /** Android's importance for its channel: 4 makes a sound and peeks, 3 makes a sound, 2 is silent. */
  importance: 2 | 3 | 4
}

export const PUSH_CATEGORIES: PushCategoryInfo[] = [
  {
    id: "sessions",
    title: "Questions, approvals and plans",
    kinds: ["approval", "question", "plan"],
    on: true,
    importance: 4,
  },
  { id: "theseus", title: "Theseus needs you", kinds: ["theseus"], on: true, importance: 4 },
  { id: "run_failed", title: "A run failed", kinds: ["run_failed"], on: true, importance: 4 },
  { id: "run_done", title: "A run finished", kinds: ["run_done"], on: false, importance: 3 },
  {
    id: "pr_checks",
    title: "Pull request checks failing",
    kinds: ["pr_checks"],
    on: true,
    importance: 3,
  },
  { id: "pr_merged", title: "Pull request merged", kinds: ["pr_merged"], on: false, importance: 2 },
  {
    id: "clone_failed",
    title: "Project setup failed",
    kinds: ["clone_failed"],
    on: true,
    importance: 3,
  },
  {
    id: "routine_failed",
    title: "A routine failed",
    kinds: ["routine_failed"],
    on: true,
    importance: 3,
  },
]

export type PushPrefs = Partial<Record<PushCategory, boolean>>

export function categoryOn(category: PushCategoryInfo, prefs: PushPrefs | undefined) {
  return prefs?.[category.id] ?? category.on
}

/** The kinds of push this device wants: what the plugin and the registry filter on. */
export function wantedKinds(prefs: PushPrefs | undefined) {
  return PUSH_CATEGORIES.filter((category) => categoryOn(category, prefs)).flatMap(
    (category) => category.kinds,
  )
}

/** Where a tapped notification goes: the session it is about, or the screen of what failed. */
export function pushPath(kind: unknown, id: unknown) {
  if (kind === "routine_failed") return "/routines"
  if (kind === "clone_failed") return "/code"
  return typeof id === "string" && id ? `/s/${encodeURIComponent(id)}` : null
}

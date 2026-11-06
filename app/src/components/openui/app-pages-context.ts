import { createContext } from "react"

import type { AppPages } from "@/lib/app-pages"

/**
 * The navigation the apps screen provides around a drawn page (ADR 0101). Kept apart from `Link` so
 * the screen can provide it without pulling the lazily loaded renderer into its own chunk.
 */
export const AppPagesContext = createContext<AppPages | null>(null)

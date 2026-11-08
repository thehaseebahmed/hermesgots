/**
 * The libraries a canvas may ask for by name, as the source the app inlines into the page
 * (`canvas-document.ts` answers an ask with one of these).
 *
 * The page is drawn with no network and a policy that allows no connection, so a library is only
 * ever the one the app already ships: these three are read out of the bundle the app is built from,
 * as text, and live in the canvas route's lazy chunk — a chat that never opens a canvas pays
 * nothing for them. Chart.js is UMD and needs no preparation; Day.js and lucide are the same
 * globals a CDN would have handed the page.
 */

import type { CanvasLibrary } from "@/lib/canvas-document"

// chart.js's exports map does not publish dist/, so the file is reached by path.
import chart from "../../node_modules/chart.js/dist/chart.umd.min.js?raw"
import date from "dayjs/dayjs.min.js?raw"
import icons from "lucide/dist/umd/lucide.min.js?raw"

export const CANVAS_LIBRARIES: Record<CanvasLibrary, string> = { chart, date, icons }

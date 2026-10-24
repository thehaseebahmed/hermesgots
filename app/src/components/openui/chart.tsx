import { defineComponent, type ComponentRenderProps } from "@openuidev/react-lang"
import { z } from "zod/v4"

import { lazySurface, SURFACE_FRAME } from "./surface.tsx"

const seriesSchema = z.object({
  name: z.string(),
  points: z.array(z.object({ x: z.string(), y: z.number() })),
})

export type ChartSeries = z.infer<typeof seriesSchema>

const chartProps = z.object({
  kind: z.enum(["bar", "line", "area", "pie"]),
  series: z.array(seriesSchema),
  xLabel: z.string().optional(),
  yLabel: z.string().optional(),
  summary: z.string(),
})

export type ChartProps = z.infer<typeof chartProps>

// Recharts is ~100kB and most replies draw no chart, so it arrives only when one does. This module
// stays light: the import below is the whole of its claim on that code.
const ChartSurface = lazySurface(
  () => import("./chart-surface.tsx"),
  <div className={SURFACE_FRAME} aria-hidden />,
)

export const Chart = defineComponent({
  name: "Chart",
  props: chartProps,
  description: "A bar, line, area or pie chart; summary in words.",
  component: ({ props }: ComponentRenderProps<ChartProps>) => <ChartSurface props={props} />,
})

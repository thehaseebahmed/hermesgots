import {
  Area,
  AreaChart,
  Bar,
  BarChart,
  CartesianGrid,
  Line,
  LineChart,
  Pie,
  PieChart,
  XAxis,
  YAxis,
} from "recharts"

import {
  ChartContainer,
  ChartLegend,
  ChartLegendContent,
  ChartTooltip,
  ChartTooltipContent,
  type ChartConfig,
} from "@/components/ui/chart"
import { estimateWidth, yAxisOf, yAxisWidth } from "@/lib/openui-chart"

import type { ChartProps, ChartSeries } from "./chart.tsx"

const PALETTE = ["--chart-1", "--chart-2", "--chart-3", "--chart-4", "--chart-5"].map(
  (token) => `var(${token})`,
)

const colour = (index: number) => PALETTE[index % PALETTE.length]

type Column = { key: string; label: string }

/**
 * A cartesian series is keyed by position so a name with a space in it stays a label; a pie's
 * columns are its slices, whose own labels the legend and the tooltip read.
 */
const columnsOf = ({ kind, series }: ChartProps): Column[] =>
  kind === "pie"
    ? (series[0]?.points ?? []).map((point) => ({ key: point.x, label: point.x }))
    : series.map((s, i) => ({ key: `series-${i}`, label: s.name }))

/**
 * A pie's config carries labels alone: its slices take `--chart-N` from their own row, while a
 * cartesian mark reads `var(--color-<key>)` back out of the config. A pie's key is the slice's
 * own text — model-written, and a custom property cannot hold a space — so it is only a label.
 */
function configOf(kind: ChartProps["kind"], columns: Column[]): ChartConfig {
  return Object.fromEntries(
    columns.map((column, i) => [
      column.key,
      kind === "pie" ? { label: column.label } : { label: column.label, color: colour(i) },
    ]),
  )
}

/**
 * Recharts wants one row per x, with a key per series in it, so the series share one table: a
 * missing point stays null and draws as a gap rather than a drop to zero.
 */
function rowsOf(series: ChartSeries[], columns: Column[]) {
  const xs = [...new Set(series.flatMap((s) => s.points.map((p) => p.x)))]
  return xs.map((x) => {
    const row: Record<string, string | number | null> = { x }
    series.forEach((s, i) => (row[columns[i].key] = s.points.find((p) => p.x === x)?.y ?? null))
    return row
  })
}

/**
 * A sector takes its fill from its own data row, which is what the legend and the tooltip read
 * the colour back from. It is written as the token rather than `var(--color-<x>)` because an x
 * value is arbitrary model-written text, and a custom property cannot have a space in its name.
 */
const slicesOf = (series: ChartSeries[]) =>
  (series[0]?.points ?? []).map((point, i) => ({ ...point, fill: colour(i) }))

const AXIS = {
  tickLine: false,
  axisLine: false,
  tickMargin: 4,
  tickSize: 6,
  fontSize: 11,
} as const

const MARGIN = { top: 4, right: 8, bottom: 16, left: 0 } as const

/** The stub and margin a tick label keeps from the plot, and a pixel of slack for a loading font. */
const LABEL_ROOM = AXIS.tickSize + AXIS.tickMargin + 2

/** The narrowest axis drawn: one- and two-digit labels need no less, or the y label crowds them. */
const LEAST_AXIS = 32

/** The column a rotated y label takes inside the axis, beside the ticks it names. */
const LABEL_BAND = 12

let painter: CanvasRenderingContext2D | null | undefined
let family: string | undefined

/** The canvas a label is measured on, or null where the DOM has no 2D one — a test's, by default. */
function painterOf() {
  if (painter === undefined)
    painter =
      typeof CanvasRenderingContext2D === "undefined"
        ? null
        : document.createElement("canvas").getContext("2d")
  return painter
}

/**
 * How wide a tick label draws. The axis has no font of its own — it inherits the thread's — so the
 * canvas takes the page's, and a page that can't measure gets an estimate that errs wide.
 */
function measure(label: string) {
  const context = painterOf()
  if (!context) return estimateWidth(label, AXIS.fontSize)
  family ??= getComputedStyle(document.body).fontFamily || "sans-serif"
  context.font = `${AXIS.fontSize}px ${family}`
  return context.measureText(label).width
}

function ChartSurface({ props }: { props: ChartProps }) {
  const columns = columnsOf(props)
  const config = configOf(props.kind, columns)
  const { xLabel, yLabel } = props
  const axis = yAxisOf(props.series.flatMap((series) => series.points.map((point) => point.y)))
  const labels = axis.ticks.map((tick) => String(tick))
  const axisWidth = yAxisWidth(labels, measure, LABEL_ROOM, LEAST_AXIS) + (yLabel ? LABEL_BAND : 0)
  const frame = (
    <>
      <CartesianGrid vertical={false} />
      <XAxis
        dataKey="x"
        name={xLabel}
        label={xLabel ? { value: xLabel, position: "insideBottom", offset: -6 } : undefined}
        {...AXIS}
      />
      <YAxis
        name={yLabel}
        width={axisWidth}
        domain={axis.domain}
        ticks={axis.ticks}
        label={yLabel ? { value: yLabel, angle: -90, position: "insideLeft" } : undefined}
        {...AXIS}
      />
      <ChartTooltip cursor={false} content={<ChartTooltipContent />} />
      <ChartLegend content={<ChartLegendContent />} />
    </>
  )

  return (
    <div role="img" aria-label={props.summary} className="h-56 w-full min-w-0">
      <ChartContainer config={config} className="aspect-auto h-full w-full">
        {props.kind === "pie" ? (
          <PieChart>
            <ChartTooltip content={<ChartTooltipContent nameKey="x" hideLabel />} />
            <Pie
              data={slicesOf(props.series)}
              dataKey="y"
              nameKey="x"
              labelLine={false}
              // Recharts anchors a function label 20px beyond the sector edge. Drawing the pie at
              // 70% leaves that 20px inside the bubble rather than clipped by its 224px height,
              // and keeps the low labels clear of the band the legend reserves.
              outerRadius="70%"
              label={(slice) => {
                // Slices under this share sit close enough that neighbouring numbers collide;
                // the legend still names them.
                if ((slice.percent ?? 0) < 0.06) return null
                return (
                  <text
                    x={slice.x}
                    y={slice.y}
                    textAnchor={slice.textAnchor}
                    dominantBaseline={slice.dominantBaseline}
                    fontSize={11}
                    fill="var(--foreground)"
                  >
                    {slice.payload.y}
                  </text>
                )
              }}
            />
            <ChartLegend content={<ChartLegendContent nameKey="x" />} />
          </PieChart>
        ) : props.kind === "bar" ? (
          <BarChart data={rowsOf(props.series, columns)} margin={MARGIN}>
            {frame}
            {columns.map((column) => (
              <Bar
                key={column.key}
                dataKey={column.key}
                fill={`var(--color-${column.key})`}
                radius={4}
              />
            ))}
          </BarChart>
        ) : props.kind === "line" ? (
          <LineChart data={rowsOf(props.series, columns)} margin={MARGIN}>
            {frame}
            {columns.map((column) => (
              <Line
                key={column.key}
                dataKey={column.key}
                type="monotone"
                stroke={`var(--color-${column.key})`}
                strokeWidth={2}
                dot={false}
              />
            ))}
          </LineChart>
        ) : (
          <AreaChart data={rowsOf(props.series, columns)} margin={MARGIN}>
            {frame}
            {columns.map((column) => (
              <Area
                key={column.key}
                dataKey={column.key}
                type="natural"
                stroke={`var(--color-${column.key})`}
                fill={`var(--color-${column.key})`}
                fillOpacity={0.4}
              />
            ))}
          </AreaChart>
        )}
      </ChartContainer>
    </div>
  )
}

export default ChartSurface

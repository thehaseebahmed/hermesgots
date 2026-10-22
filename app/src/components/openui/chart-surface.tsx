import {
  Area,
  AreaChart,
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
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

import type { ChartProps, ChartSeries } from "./chart.tsx"

/** The app's chart tokens: five series colours, and a sixth series starts them again. */
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
 * A pie's config carries labels alone: its slices take the tokens directly, and a slice label is
 * arbitrary text where a cartesian series' generated key is safe to write as a CSS name.
 */
function configOf(kind: ChartProps["kind"], columns: Column[]): ChartConfig {
  return Object.fromEntries(
    columns.map((column, i) => [
      column.key,
      kind === "pie"
        ? { label: column.label }
        : { label: column.label, theme: { light: colour(i), dark: colour(i) } },
    ]),
  )
}

/**
 * Recharts wants one row per x, with a key per series in it, so the series share one table: a
 * missing point stays null and draws as a gap rather than a drop to zero.
 */
function rowsOf(series: ChartSeries[], columns: Column[]) {
  const xs: string[] = []
  for (const s of series) for (const p of s.points) if (!xs.includes(p.x)) xs.push(p.x)
  return xs.map((x) => {
    const row: Record<string, string | number | null> = { x }
    series.forEach((s, i) => (row[columns[i].key] = s.points.find((p) => p.x === x)?.y ?? null))
    return row
  })
}

const AXIS = { tickLine: false, axisLine: false, tickMargin: 4, fontSize: 11 } as const

const MARGIN = { top: 4, right: 8, bottom: 16, left: 0 } as const

function ChartSurface({ props }: { props: ChartProps }) {
  const columns = columnsOf(props)
  const config = configOf(props.kind, columns)
  const { xLabel, yLabel } = props
  const frame = (
    <>
      <CartesianGrid strokeDasharray="3 3" vertical={false} />
      <XAxis
        dataKey="x"
        name={xLabel}
        label={xLabel ? { value: xLabel, position: "insideBottom", offset: -6 } : undefined}
        {...AXIS}
      />
      <YAxis
        name={yLabel}
        width={yLabel ? 44 : 32}
        label={yLabel ? { value: yLabel, angle: -90, position: "insideLeft" } : undefined}
        {...AXIS}
      />
      <ChartTooltip content={<ChartTooltipContent />} />
      <ChartLegend content={<ChartLegendContent />} />
    </>
  )

  return (
    <div role="img" aria-label={props.summary} className="h-56 w-full min-w-0">
      <ChartContainer config={config} className="aspect-auto h-full w-full">
        {props.kind === "pie" ? (
          <PieChart>
            <ChartTooltip content={<ChartTooltipContent nameKey="x" />} />
            <Pie data={props.series[0]?.points ?? []} dataKey="y" nameKey="x">
              {columns.map((column, i) => (
                <Cell key={column.key} fill={colour(i)} />
              ))}
            </Pie>
            <ChartLegend content={<ChartLegendContent nameKey="x" />} />
          </PieChart>
        ) : props.kind === "bar" ? (
          <BarChart data={rowsOf(props.series, columns)} margin={MARGIN}>
            {frame}
            {columns.map((column) => (
              <Bar key={column.key} dataKey={column.key} fill={`var(--color-${column.key})`} />
            ))}
          </BarChart>
        ) : props.kind === "line" ? (
          <LineChart data={rowsOf(props.series, columns)} margin={MARGIN}>
            {frame}
            {columns.map((column) => (
              <Line
                key={column.key}
                dataKey={column.key}
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
                stroke={`var(--color-${column.key})`}
                fill={`var(--color-${column.key})`}
                fillOpacity={0.2}
              />
            ))}
          </AreaChart>
        )}
      </ChartContainer>
    </div>
  )
}

export default ChartSurface

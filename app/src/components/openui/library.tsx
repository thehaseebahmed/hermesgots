import { Fragment } from "react"
import {
  createLibrary,
  createParser,
  defineComponent,
  type ComponentRenderProps,
  type SubComponentOf,
} from "@openuidev/react-lang"
import { CheckCircle2Icon, InfoIcon, TriangleAlertIcon } from "lucide-react"
import { z } from "zod/v4"

import { Alert, AlertDescription } from "@/components/ui/alert"
import { Card as CardSurface, CardContent, CardHeader, CardTitle } from "@/components/ui/card"

import { Chart } from "./chart.tsx"
import { OPENUI_ROOT } from "./root.ts"

const child: z.ZodType<SubComponentOf<unknown>> = z.lazy(() =>
  z.union([Card.ref, Table.ref, List.ref, Callout.ref, Chart.ref]),
)

const stackProps = z.object({ children: z.array(child) })
const cardProps = z.object({
  title: z.string(),
  body: z.string().optional(),
  children: z.array(child).optional(),
})
const tableProps = z.object({
  columns: z.array(z.string()),
  rows: z.array(z.array(z.union([z.string(), z.number()]))),
  caption: z.string().optional(),
})
const listProps = z.object({
  items: z.array(z.object({ label: z.string(), detail: z.string().optional() })),
  ordered: z.boolean().optional(),
})
const calloutProps = z.object({ tone: z.enum(["info", "warn", "good"]), text: z.string() })

const TONES = {
  info: { Icon: InfoIcon, className: "bg-info/10 *:[svg]:text-info" },
  warn: { Icon: TriangleAlertIcon, className: "bg-warning/10 *:[svg]:text-warning" },
  good: { Icon: CheckCircle2Icon, className: "bg-success/10 *:[svg]:text-success" },
}

const Stack = defineComponent({
  name: OPENUI_ROOT,
  props: stackProps,
  description: "A column of blocks.",
  component: ({ props, renderNode }: ComponentRenderProps<z.infer<typeof stackProps>>) => (
    <div className="w-full min-w-0 space-y-3">
      {props.children.map((node, i) => (
        <Fragment key={i}>{renderNode(node)}</Fragment>
      ))}
    </div>
  ),
})

const Card = defineComponent({
  name: "Card",
  props: cardProps,
  description: "Titled card: paragraph, then children.",
  component: ({ props, renderNode }: ComponentRenderProps<z.infer<typeof cardProps>>) => (
    <CardSurface size="sm">
      <CardHeader>
        <CardTitle>{props.title}</CardTitle>
      </CardHeader>
      {props.body || props.children?.length ? (
        <CardContent className="space-y-3">
          {props.body ? <p>{props.body}</p> : null}
          {props.children?.map((node, i) => (
            <Fragment key={i}>{renderNode(node)}</Fragment>
          ))}
        </CardContent>
      ) : null}
    </CardSurface>
  ),
})

const Table = defineComponent({
  name: "Table",
  props: tableProps,
  description: "Plain-text cells, optional caption.",
  component: ({ props }: ComponentRenderProps<z.infer<typeof tableProps>>) => (
    <div className="w-full overflow-x-auto">
      <table className="w-full text-sm">
        {props.caption ? (
          <caption className="pb-2 text-left text-muted-foreground">{props.caption}</caption>
        ) : null}
        <thead>
          <tr className="border-b border-border text-left">
            {props.columns.map((column, i) => (
              <th key={i} className="px-2 py-1.5 font-medium">
                {column}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {props.rows.map((row, i) => (
            <tr key={i} className="border-b border-border last:border-0">
              {row.map((cell, j) => (
                <td key={j} className="px-2 py-1.5">
                  {cell}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  ),
})

const List = defineComponent({
  name: "List",
  props: listProps,
  description: "Label and optional detail.",
  component: ({ props }: ComponentRenderProps<z.infer<typeof listProps>>) => {
    const items = props.items.map((item, i) => (
      <li key={i} className="my-1">
        {item.label}
        {item.detail ? <div className="text-muted-foreground">{item.detail}</div> : null}
      </li>
    ))
    return props.ordered ? (
      <ol className="list-decimal pl-5 text-sm">{items}</ol>
    ) : (
      <ul className="list-disc pl-5 text-sm">{items}</ul>
    )
  },
})

const Callout = defineComponent({
  name: "Callout",
  props: calloutProps,
  description: "A one-line aside: info, warn, good.",
  component: ({ props }: ComponentRenderProps<z.infer<typeof calloutProps>>) => {
    const { Icon, className } = TONES[props.tone]
    return (
      <Alert className={className}>
        <Icon aria-hidden />
        <AlertDescription className="text-foreground">{props.text}</AlertDescription>
      </Alert>
    )
  },
})

export const library = createLibrary({
  components: [Stack, Card, Table, List, Callout, Chart],
  root: OPENUI_ROOT,
})
export const parser = createParser(library.toJSONSchema(), OPENUI_ROOT)

import { referenceEntries as deriveReferences } from "@/lib/openui-reference"

import { library } from "./library.tsx"

const EXAMPLES: Record<string, string> = {
  Stack: [
    "root = Stack([first, second])",
    'first = Callout("info", "A column holds blocks.")',
    'second = Callout("good", "Each one under the last.")',
  ].join("\n"),
  Card: ["root = Stack([card])", 'card = Card("Berlin", "16° and clear.")'].join("\n"),
  Table: [
    "root = Stack([table])",
    'table = Table(["City", "Days"], [["Berlin", 3], ["Lisbon", 5]], "Trip")',
  ].join("\n"),
  List: [
    "root = Stack([list])",
    'list = List([{ label: "Send the invoice", detail: "Due today" }, { label: "Book the train" }])',
  ].join("\n"),
  Callout: ["root = Stack([note])", 'note = Callout("warn", "The kitchen window is open.")'].join(
    "\n",
  ),
  Chart: [
    "root = Stack([chart])",
    'chart = Chart("bar", [{ name: "Energy", points: [{ x: "Mon", y: 4 }, { x: "Tue", y: 6 }] }], "Day", "kWh", "10 kWh over two days.")',
  ].join("\n"),
  Map: [
    "root = Stack([map])",
    'map = Map([{ lat: 52.52, lng: 13.405, label: "Berlin", detail: "Home" }], "One place: Berlin.")',
  ].join("\n"),
}

export function referenceEntries() {
  return deriveReferences({
    components: Object.keys(library.components),
    root: library.root,
    schema: library.toJSONSchema(),
    examples: EXAMPLES,
  })
}

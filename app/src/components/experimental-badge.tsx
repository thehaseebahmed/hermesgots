import { Badge } from "@/components/ui/badge"

/** Marks a feature that can break, like Theseus, wherever it can be turned on or picked. */
export function ExperimentalBadge() {
  return <Badge className="bg-warning/15 text-warning">Experimental</Badge>
}

import { Badge } from "@/components/ui/badge"

/** Marks a feature the app still considers a lab, wherever it can be turned on or picked. */
export function LabBadge() {
  return <Badge className="bg-warning/15 px-2.5 text-warning">Lab</Badge>
}

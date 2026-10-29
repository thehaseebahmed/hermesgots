import { ArrowLeftIcon } from "lucide-react"

import { Button } from "@/components/ui/button"

/** The round control a header leads back with. */
export function HeaderBack({ label, onClick }: { label: string; onClick: () => void }) {
  return (
    <Button
      variant="outline"
      size="icon-lg"
      className="size-11 rounded-full bg-background/80 backdrop-blur"
      onClick={onClick}
      aria-label={label}
    >
      <ArrowLeftIcon />
    </Button>
  )
}

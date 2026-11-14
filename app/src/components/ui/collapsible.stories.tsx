import type { Meta, StoryObj } from "@storybook/react-vite"

import { Button } from "@/components/ui/button"
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible"

const meta = { title: "UI/Collapsible", component: Collapsible } satisfies Meta<typeof Collapsible>

export default meta
type Story = StoryObj<typeof meta>

const body = (
  <>
    <CollapsibleTrigger render={<Button variant="ghost">Archived (3)</Button>} />
    <CollapsibleContent className="px-3 text-sm text-muted-foreground">
      Three folded rows.
    </CollapsibleContent>
  </>
)

export const Closed: Story = { render: () => <Collapsible>{body}</Collapsible> }
export const Open: Story = { render: () => <Collapsible defaultOpen>{body}</Collapsible> }

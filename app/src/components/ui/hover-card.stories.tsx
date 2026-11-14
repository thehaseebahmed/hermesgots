import type { Meta, StoryObj } from "@storybook/react-vite"

import { Button } from "@/components/ui/button"
import { HoverCard, HoverCardContent, HoverCardTrigger } from "@/components/ui/hover-card"

const meta = { title: "UI/HoverCard", component: HoverCard } satisfies Meta<typeof HoverCard>

export default meta
type Story = StoryObj<typeof meta>

export const Open: Story = {
  render: () => (
    <div className="h-48">
      <HoverCard defaultOpen>
        <HoverCardTrigger render={<Button variant="link">A citation</Button>} />
        <HoverCardContent className="text-sm">The claim and its source.</HoverCardContent>
      </HoverCard>
    </div>
  ),
}

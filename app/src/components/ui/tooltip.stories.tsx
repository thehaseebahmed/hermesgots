import type { Meta, StoryObj } from "@storybook/react-vite"

import { Button } from "@/components/ui/button"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"

const meta = { title: "UI/Tooltip", component: Tooltip } satisfies Meta<typeof Tooltip>

export default meta
type Story = StoryObj<typeof meta>

export const Open: Story = {
  render: () => (
    <div className="h-32 pt-12">
      <Tooltip defaultOpen>
        <TooltipTrigger render={<Button variant="secondary">Hover me</Button>} />
        <TooltipContent>What this does</TooltipContent>
      </Tooltip>
    </div>
  ),
}

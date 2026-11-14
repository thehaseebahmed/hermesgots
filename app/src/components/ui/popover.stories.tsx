import type { Meta, StoryObj } from "@storybook/react-vite"

import { Button } from "@/components/ui/button"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"

const meta = { title: "UI/Popover", component: Popover } satisfies Meta<typeof Popover>

export default meta
type Story = StoryObj<typeof meta>

export const Open: Story = {
  render: () => (
    <div className="h-48">
      <Popover defaultOpen>
        <PopoverTrigger render={<Button variant="secondary">Why is this off?</Button>} />
        <PopoverContent className="text-sm">The host says no, in its own words.</PopoverContent>
      </Popover>
    </div>
  ),
}

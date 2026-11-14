import type { Meta, StoryObj } from "@storybook/react-vite"

import { Separator } from "@/components/ui/separator"

const meta = { title: "UI/Separator", component: Separator } satisfies Meta<typeof Separator>

export default meta
type Story = StoryObj<typeof meta>

export const Horizontal: Story = { render: () => <Separator className="max-w-sm" /> }
export const Vertical: Story = {
  render: () => (
    <div className="flex h-8 items-center gap-3 text-sm">
      Cancel <Separator orientation="vertical" /> Save
    </div>
  ),
}

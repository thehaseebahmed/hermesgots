import type { Meta, StoryObj } from "@storybook/react-vite"

import { Switch } from "@/components/ui/switch"

const meta = { title: "UI/Switch", component: Switch } satisfies Meta<typeof Switch>

export default meta
type Story = StoryObj<typeof meta>

export const Off: Story = { args: { "aria-label": "Setting" } }
export const On: Story = { args: { "aria-label": "Setting", defaultChecked: true } }
export const Disabled: Story = { args: { "aria-label": "Setting", disabled: true } }
export const DisabledOn: Story = {
  args: { "aria-label": "Setting", disabled: true, defaultChecked: true },
}

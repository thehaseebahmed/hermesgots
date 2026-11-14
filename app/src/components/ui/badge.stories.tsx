import type { Meta, StoryObj } from "@storybook/react-vite"

import { LabBadge } from "@/components/lab-badge"
import { Badge } from "@/components/ui/badge"

const meta = {
  title: "Components/Badge",
  component: Badge,
  args: { children: "Badge" },
  argTypes: {
    variant: {
      control: "select",
      options: ["default", "secondary", "outline", "destructive", "ghost", "link"],
    },
  },
} satisfies Meta<typeof Badge>

export default meta
type Story = StoryObj<typeof meta>

export const Default: Story = {}
export const Secondary: Story = { args: { variant: "secondary" } }
export const Outline: Story = { args: { variant: "outline" } }
export const Destructive: Story = { args: { variant: "destructive" } }
export const Labs: Story = { render: () => <LabBadge /> }

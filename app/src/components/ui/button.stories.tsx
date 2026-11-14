import type { Meta, StoryObj } from "@storybook/react-vite"
import { Trash2Icon } from "lucide-react"

import { Button } from "@/components/ui/button"

const meta = {
  title: "Components/Button",
  component: Button,
  args: { children: "Button", size: "lg" },
  argTypes: {
    variant: {
      control: "select",
      options: ["default", "secondary", "outline", "ghost", "destructive", "link"],
    },
    size: { control: "select", options: ["default", "xs", "sm", "lg", "icon"] },
  },
} satisfies Meta<typeof Button>

export default meta
type Story = StoryObj<typeof meta>

export const Primary: Story = {}
export const Secondary: Story = { args: { variant: "secondary" } }
export const Outline: Story = { args: { variant: "outline" } }
export const Ghost: Story = { args: { variant: "ghost" } }
export const Disabled: Story = { args: { disabled: true } }
export const Destructive: Story = {
  args: {
    variant: "destructive",
    children: (
      <>
        <Trash2Icon data-icon="inline-start" />
        Delete
      </>
    ),
  },
}

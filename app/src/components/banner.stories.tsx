import type { Meta, StoryObj } from "@storybook/react-vite"

import { Banner } from "@/components/banner"

const meta = {
  title: "Components/Banner",
  component: Banner,
  argTypes: { tone: { control: "select", options: ["info", "warning", "error"] } },
  args: { tone: "info", children: "Info says what is true." },
} satisfies Meta<typeof Banner>

export default meta
type Story = StoryObj<typeof meta>

export const Info: Story = {}
export const Warning: Story = {
  args: { tone: "warning", children: "A warning says what to watch." },
}
export const Error: Story = {
  args: { tone: "error", children: "An error says what failed and what to try." },
}
export const WithoutIcon: Story = { args: { icon: false } }

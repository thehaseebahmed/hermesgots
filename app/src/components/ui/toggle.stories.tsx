import type { Meta, StoryObj } from "@storybook/react-vite"
import { BoldIcon, ItalicIcon } from "lucide-react"

import { Toggle } from "@/components/ui/toggle"
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group"

const meta = { title: "UI/Toggle", component: Toggle } satisfies Meta<typeof Toggle>

export default meta
type Story = StoryObj<typeof meta>

export const Off: Story = {
  render: () => (
    <Toggle aria-label="Bold">
      <BoldIcon />
    </Toggle>
  ),
}
export const On: Story = {
  render: () => (
    <Toggle aria-label="Bold" defaultPressed>
      <BoldIcon />
    </Toggle>
  ),
}
export const Disabled: Story = {
  render: () => (
    <Toggle aria-label="Bold" disabled>
      <BoldIcon />
    </Toggle>
  ),
}
export const Group: Story = {
  render: () => (
    <ToggleGroup defaultValue={["bold"]}>
      <ToggleGroupItem value="bold" aria-label="Bold">
        <BoldIcon />
      </ToggleGroupItem>
      <ToggleGroupItem value="italic" aria-label="Italic">
        <ItalicIcon />
      </ToggleGroupItem>
    </ToggleGroup>
  ),
}

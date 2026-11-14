import type { Meta, StoryObj } from "@storybook/react-vite"

import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Textarea } from "@/components/ui/textarea"

const meta = { title: "UI/Input", component: Input } satisfies Meta<typeof Input>

export default meta
type Story = StoryObj<typeof meta>

const field = "h-12 max-w-sm rounded-full px-4"

export const Empty: Story = { args: { placeholder: "Name", className: field } }
export const Filled: Story = { args: { defaultValue: "Hermes", className: field } }
export const Disabled: Story = {
  args: { defaultValue: "Hermes", disabled: true, className: field },
}
export const Invalid: Story = {
  args: { defaultValue: "", "aria-invalid": true, placeholder: "Name", className: field },
}
export const WithLabel: Story = {
  render: () => (
    <div className="flex max-w-sm flex-col gap-2">
      <Label htmlFor="story-name" className="text-muted-foreground">
        Name
      </Label>
      <Input id="story-name" defaultValue="Hermes" className={field} />
    </div>
  ),
}
export const MultiLine: Story = {
  render: () => <Textarea className="max-w-sm" placeholder="Say more" defaultValue="" />,
}

import type { Meta, StoryObj } from "@storybook/react-vite"

import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"

const meta = { title: "UI/Select", component: Select } satisfies Meta<typeof Select>

export default meta
type Story = StoryObj<typeof meta>

const items = [
  { value: "a", label: "Project A" },
  { value: "b", label: "Project B" },
]

const select = (props: { defaultOpen?: boolean; disabled?: boolean }) => (
  <div className="h-48 max-w-xs">
    <Select items={items} defaultValue="a" {...props}>
      <SelectTrigger className="w-full">
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        {items.map((item) => (
          <SelectItem key={item.value} value={item.value}>
            {item.label}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  </div>
)

export const Closed: Story = { render: () => select({}) }
export const Open: Story = { render: () => select({ defaultOpen: true }) }
export const Disabled: Story = { render: () => select({ disabled: true }) }

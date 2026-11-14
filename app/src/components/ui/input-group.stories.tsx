import type { Meta, StoryObj } from "@storybook/react-vite"
import { SearchIcon } from "lucide-react"

import { InputGroup, InputGroupAddon, InputGroupInput } from "@/components/ui/input-group"

const meta = { title: "UI/InputGroup", component: InputGroup } satisfies Meta<typeof InputGroup>

export default meta
type Story = StoryObj<typeof meta>

export const WithAddon: Story = {
  render: () => (
    <InputGroup className="max-w-sm">
      <InputGroupAddon>
        <SearchIcon />
      </InputGroupAddon>
      <InputGroupInput placeholder="Search" />
    </InputGroup>
  ),
}

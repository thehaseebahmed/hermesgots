import type { Meta, StoryObj } from "@storybook/react-vite"
import { useState } from "react"

import { SearchField } from "@/components/search-field"

const meta = { title: "Components/SearchField", component: SearchField } satisfies Meta<
  typeof SearchField
>

export default meta
type Story = StoryObj<typeof meta>

export const Default: Story = {
  args: { value: "", onChange: () => {}, label: "Search" },
  render: function Render() {
    const [value, setValue] = useState("")
    return (
      <div className="max-w-sm">
        <SearchField value={value} onChange={setValue} label="Search" />
      </div>
    )
  },
}

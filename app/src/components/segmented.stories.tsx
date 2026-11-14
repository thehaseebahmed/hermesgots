import type { Meta, StoryObj } from "@storybook/react-vite"
import { useState } from "react"

import { Segmented } from "@/components/segmented"

const meta = { title: "Components/Segmented", component: Segmented } satisfies Meta<
  typeof Segmented
>

export default meta
type Story = StoryObj<typeof meta>

export const Default: Story = {
  args: { label: "Width", options: [], value: "", onChange: () => {} },
  render: function Render() {
    const [value, setValue] = useState("one")
    return (
      <Segmented
        label="Example"
        value={value}
        onChange={setValue}
        options={[
          { id: "one", label: "One" },
          { id: "two", label: "Two" },
          { id: "three", label: "Three" },
        ]}
      />
    )
  },
}

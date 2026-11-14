import type { Meta, StoryObj } from "@storybook/react-vite"
import { useState } from "react"

import { PickGroup, PickRow } from "@/components/pick-row"

const meta = { title: "Components/PickRow", component: PickRow } satisfies Meta<typeof PickRow>

export default meta
type Story = StoryObj<typeof meta>

export const Choose: Story = {
  args: { title: "Choice" },
  render: function Render() {
    const [pick, setPick] = useState("a")
    return (
      <div className="max-w-sm">
        <PickGroup mode="choose" surface="plate" heading="Choose one">
          {["a", "b"].map((id) => (
            <PickRow
              key={id}
              title={id === "a" ? "First choice" : "Second choice"}
              line="A pick is one control wherever a sheet offers a list"
              selected={pick === id}
              onPick={() => setPick(id)}
            />
          ))}
        </PickGroup>
      </div>
    )
  },
}

export const Open: Story = {
  args: { title: "Choice" },
  render: () => (
    <div className="max-w-sm">
      <PickGroup mode="open" heading="Goes somewhere">
        <PickRow title="A row with a way in" line="Its chevron says so" onPick={() => {}} />
      </PickGroup>
    </div>
  ),
}

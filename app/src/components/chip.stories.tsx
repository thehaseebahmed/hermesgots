import type { Meta, StoryObj } from "@storybook/react-vite"
import { useState } from "react"

import { Chip } from "@/components/chip"

const meta = { title: "Components/Chip", component: Chip } satisfies Meta<typeof Chip>

export default meta
type Story = StoryObj<typeof meta>

export const Row: Story = {
  args: { active: true, onClick: () => {}, children: "All" },
  render: function Render() {
    const [active, setActive] = useState("All")
    return (
      <div className="flex gap-2">
        {["All", "Unread", "Chats"].map((label) => (
          <Chip key={label} active={active === label} onClick={() => setActive(label)}>
            {label}
          </Chip>
        ))}
      </div>
    )
  },
}

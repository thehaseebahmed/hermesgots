import type { Meta, StoryObj } from "@storybook/react-vite"
import { BellIcon, SparklesIcon } from "lucide-react"
import { useState } from "react"
import { MemoryRouter } from "react-router"

import { Group, LinkRow, RowText, SwitchRow, rowClass } from "@/components/settings-chrome"

const meta = { title: "Components/Settings group", component: Group } satisfies Meta<typeof Group>

export default meta
type Story = StoryObj<typeof meta>

export const Rows: Story = {
  args: { children: null },
  render: function Render() {
    const [on, setOn] = useState(true)
    return (
      <MemoryRouter>
        <div className="max-w-md">
          <Group>
            <LinkRow
              to="/"
              leading={<BellIcon className="size-5 shrink-0 text-muted-foreground" />}
              title="A row that goes somewhere"
              subtitle="Its muted line says what it holds"
            />
            <SwitchRow
              id="story-switch"
              icon={SparklesIcon}
              title="A row with a switch"
              subtitle="The whole row toggles"
              checked={on}
              onCheckedChange={setOn}
            />
            <div className={rowClass}>
              <RowText title="A row that only reads" subtitle="Value in the accent colour" />
              <span className="text-sm text-primary">Online</span>
            </div>
          </Group>
        </div>
      </MemoryRouter>
    )
  },
}

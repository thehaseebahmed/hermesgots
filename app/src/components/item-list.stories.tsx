import type { Meta, StoryObj } from "@storybook/react-vite"
import { CircleCheckIcon, MessageSquareIcon } from "lucide-react"

import { ItemRow } from "@/components/item-list"

const meta = { title: "Components/ItemRow", component: ItemRow } satisfies Meta<typeof ItemRow>

export default meta
type Story = StoryObj<typeof meta>

export const List: Story = {
  args: { icon: null, title: "" },
  render: () => (
    <div className="max-w-md">
      <ItemRow
        icon={<MessageSquareIcon />}
        tone="warning"
        unread
        warn
        title="A chat waiting on you"
        when="1h"
        line="A question needs an answer"
      />
      <ItemRow
        icon={<MessageSquareIcon />}
        tone="success"
        title="The open item"
        when="2m"
        line="Selected rows take the accent plate"
        selected
      />
      <ItemRow icon={<CircleCheckIcon />} tone="muted" title="At rest" when="Mon" line="Done" />
    </div>
  ),
}

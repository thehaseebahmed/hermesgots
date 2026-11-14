import type { Meta, StoryObj } from "@storybook/react-vite"

import { Message, MessageContent } from "@/components/ui/message"
import { UserBubble } from "@/components/chat/user-bubble"

const meta = { title: "UI/Message", component: Message } satisfies Meta<typeof Message>

export default meta
type Story = StoryObj<typeof meta>

export const UserMessage: Story = {
  render: () => (
    <Message align="end">
      <MessageContent className="items-end gap-1">
        <UserBubble>Plan the migration in three checkpoints.</UserBubble>
      </MessageContent>
    </Message>
  ),
}

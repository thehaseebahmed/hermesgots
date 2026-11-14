import type { Meta, StoryObj } from "@storybook/react-vite"

import { Button } from "@/components/ui/button"
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"

const meta = { title: "UI/DropdownMenu", component: DropdownMenu } satisfies Meta<
  typeof DropdownMenu
>

export default meta
type Story = StoryObj<typeof meta>

export const Open: Story = {
  render: () => (
    <div className="h-72">
      <DropdownMenu defaultOpen>
        <DropdownMenuTrigger render={<Button variant="secondary">Options</Button>} />
        <DropdownMenuContent align="start">
          <DropdownMenuGroup>
            <DropdownMenuLabel>Chat</DropdownMenuLabel>
          </DropdownMenuGroup>
          <DropdownMenuItem>Rename</DropdownMenuItem>
          <DropdownMenuCheckboxItem checked>Pinned</DropdownMenuCheckboxItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem variant="destructive">Delete</DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  ),
}

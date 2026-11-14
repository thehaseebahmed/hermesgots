import type { Meta, StoryObj } from "@storybook/react-vite"

import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet"

const meta = { title: "UI/Sheet", component: Sheet } satisfies Meta<typeof Sheet>

export default meta
type Story = StoryObj<typeof meta>

const sheet = (side: "right" | "bottom" | "left" | "top") => (
  <Sheet defaultOpen>
    <SheetContent side={side}>
      <SheetHeader>
        <SheetTitle>A {side} sheet</SheetTitle>
        <SheetDescription>Pop-ups use Popup, which picks between these.</SheetDescription>
      </SheetHeader>
    </SheetContent>
  </Sheet>
)

export const Right: Story = { render: () => sheet("right") }
export const Bottom: Story = { render: () => sheet("bottom") }

import type { Meta, StoryObj } from "@storybook/react-vite"
import { useState } from "react"

import { ConfirmDestructive } from "@/components/confirm-destructive"
import { Popup, PopupContent, PopupHeader, PopupTitle } from "@/components/popup"
import { Button } from "@/components/ui/button"

const meta = {
  title: "Components/Popup",
  component: Popup,
  parameters: { layout: "fullscreen" },
} satisfies Meta<typeof Popup>

export default meta
type Story = StoryObj<typeof meta>

export const Sheet: Story = {
  globals: { viewport: { value: "mobile1", isRotated: false } },
  render: function Render() {
    const [open, setOpen] = useState(true)
    return (
      <div className="p-4">
        <Button onClick={() => setOpen(true)}>Open the sheet</Button>
        <Popup open={open} onOpenChange={setOpen}>
          <PopupContent>
            <PopupHeader>
              <PopupTitle>A bottom sheet</PopupTitle>
            </PopupHeader>
            <p className="px-4 pb-6 text-sm text-muted-foreground">
              Below 1024px a pop-up is a sheet.
            </p>
          </PopupContent>
        </Popup>
      </div>
    )
  },
}

export const Drawer: Story = {
  globals: { viewport: { value: "desktop", isRotated: false } },
  render: function Render() {
    const [open, setOpen] = useState(true)
    return (
      <div className="p-4">
        <Button onClick={() => setOpen(true)}>Open the drawer</Button>
        <Popup open={open} onOpenChange={setOpen}>
          <PopupContent>
            <PopupHeader>
              <PopupTitle>A side drawer</PopupTitle>
            </PopupHeader>
            <p className="px-4 pb-6 text-sm text-muted-foreground">From 1024px it is a drawer.</p>
          </PopupContent>
        </Popup>
      </div>
    )
  },
}

export const Confirmation: Story = {
  render: function Render() {
    const [open, setOpen] = useState(true)
    return (
      <div className="p-4">
        <Button variant="destructive" onClick={() => setOpen(true)}>
          Delete
        </Button>
        <ConfirmDestructive
          open={open}
          onOpenChange={setOpen}
          title="Delete this chat?"
          description="It can't be brought back."
          confirmLabel="Delete"
          onConfirm={async () => setOpen(false)}
        />
      </div>
    )
  },
}

export const ConfirmationBusy: Story = {
  render: () => (
    <ConfirmDestructive
      open
      busy
      onOpenChange={() => {}}
      title="Delete this chat?"
      description="Working on it."
      confirmLabel="Delete"
      onConfirm={() => new Promise(() => {})}
    />
  ),
}

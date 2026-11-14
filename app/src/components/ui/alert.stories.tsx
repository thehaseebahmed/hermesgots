import type { Meta, StoryObj } from "@storybook/react-vite"
import { InfoIcon } from "lucide-react"

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"

const meta = { title: "UI/Alert", component: Alert } satisfies Meta<typeof Alert>

export default meta
type Story = StoryObj<typeof meta>

export const Default: Story = {
  render: () => (
    <Alert className="max-w-md">
      <InfoIcon />
      <AlertTitle>Heads up</AlertTitle>
      <AlertDescription>An alert says one thing, once.</AlertDescription>
    </Alert>
  ),
}

export const Destructive: Story = {
  render: () => (
    <Alert variant="destructive" className="max-w-md">
      <InfoIcon />
      <AlertTitle>Something failed</AlertTitle>
      <AlertDescription>Say what failed and what to try.</AlertDescription>
    </Alert>
  ),
}

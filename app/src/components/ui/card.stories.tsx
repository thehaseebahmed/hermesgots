import type { Meta, StoryObj } from "@storybook/react-vite"

import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"

const meta = { title: "Components/Card", component: Card } satisfies Meta<typeof Card>

export default meta
type Story = StoryObj<typeof meta>

export const Default: Story = {
  render: () => (
    <Card className="max-w-sm">
      <CardHeader>
        <CardTitle>A feature card</CardTitle>
        <CardDescription>One surface, one hairline, no shadow</CardDescription>
      </CardHeader>
      <CardContent className="text-sm text-muted-foreground">Content sits here.</CardContent>
    </Card>
  ),
}

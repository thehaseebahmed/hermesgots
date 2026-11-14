import type { Meta, StoryObj } from "@storybook/react-vite"

import { Skeleton } from "@/components/ui/skeleton"
import { Spinner } from "@/components/ui/spinner"

const meta = { title: "Components/Loading", component: Spinner } satisfies Meta<typeof Spinner>

export default meta
type Story = StoryObj<typeof meta>

export const SpinnerBesideWords: Story = {
  render: () => (
    <div className="flex items-center gap-3 text-sm text-muted-foreground">
      <Spinner />
      Loading keeps the shape it is about to fill
    </div>
  ),
}

export const Skeletons: Story = {
  render: () => (
    <div className="flex max-w-sm flex-col gap-2">
      <Skeleton className="h-4 w-2/3" />
      <Skeleton className="h-4 w-1/2" />
    </div>
  ),
}

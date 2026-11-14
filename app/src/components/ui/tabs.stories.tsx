import type { Meta, StoryObj } from "@storybook/react-vite"

import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"

const meta = { title: "UI/Tabs", component: Tabs } satisfies Meta<typeof Tabs>

export default meta
type Story = StoryObj<typeof meta>

export const Default: Story = {
  render: () => (
    <Tabs defaultValue="config" className="max-w-md">
      <TabsList>
        <TabsTrigger value="config">Config</TabsTrigger>
        <TabsTrigger value="tools">Tools</TabsTrigger>
      </TabsList>
      <TabsContent value="config" className="py-3 text-sm">
        The block, read whole.
      </TabsContent>
      <TabsContent value="tools" className="py-3 text-sm">
        Read from the schema cache.
      </TabsContent>
    </Tabs>
  ),
}

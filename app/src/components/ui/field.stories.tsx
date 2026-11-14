import type { Meta, StoryObj } from "@storybook/react-vite"

import { Field, FieldDescription, FieldError, FieldGroup, FieldLabel } from "@/components/ui/field"
import { Input } from "@/components/ui/input"

const meta = { title: "UI/Field", component: Field } satisfies Meta<typeof Field>

export default meta
type Story = StoryObj<typeof meta>

export const Default: Story = {
  render: () => (
    <FieldGroup className="max-w-sm">
      <Field>
        <FieldLabel>Server address</FieldLabel>
        <Input placeholder="https://" />
        <FieldDescription>Where the bot's host answers.</FieldDescription>
      </Field>
      <Field data-invalid>
        <FieldLabel>Key</FieldLabel>
        <Input aria-invalid defaultValue="" />
        <FieldError>A key is needed to send.</FieldError>
      </Field>
    </FieldGroup>
  ),
}

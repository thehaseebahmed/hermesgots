import { defineComponent, useTriggerAction, type ComponentRenderProps } from "@openuidev/react-lang"
import { z } from "zod/v4"

import { Button } from "@/components/ui/button"

import { signatureRule } from "./prose.ts"

const buttonProps = z.object({
  label: z.string(),
  action: z.any().optional(),
  pending: z.boolean().optional(),
})

function ActionControl({ props }: ComponentRenderProps<z.infer<typeof buttonProps>>) {
  const trigger = useTriggerAction()
  return (
    <Button
      type="button"
      variant="outline"
      className="w-full"
      disabled={props.pending}
      aria-busy={props.pending}
      onClick={() => void trigger(props.label, undefined, props.action)}
    >
      {props.label}
    </Button>
  )
}

export const ActionButton = defineComponent({
  name: "Button",
  props: buttonProps,
  description: signatureRule("Button") ?? "",
  component: ActionControl,
})

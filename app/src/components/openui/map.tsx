import { defineComponent, type ComponentRenderProps } from "@openuidev/react-lang"
import { z } from "zod/v4"

import { signatureRule } from "./prose.ts"
import { lazySurface, SURFACE_FRAME } from "./surface.tsx"

const pointSchema = z.object({
  lat: z.number(),
  lng: z.number(),
  label: z.string(),
  detail: z.string().optional(),
})

export type MapPoint = z.infer<typeof pointSchema>

const mapProps = z.object({
  points: z.array(pointSchema),
  summary: z.string(),
})

export type MapProps = z.infer<typeof mapProps>

const MapSurface = lazySurface(
  () => import("./map-surface.tsx"),
  <div className={SURFACE_FRAME} aria-hidden />,
)

export const Map = defineComponent({
  name: "Map",
  props: mapProps,
  description: signatureRule("Map") ?? "",
  component: ({ props }: ComponentRenderProps<MapProps>) => <MapSurface props={props} />,
})

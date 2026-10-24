import { Suspense, lazy } from "react"
import { defineComponent, type ComponentRenderProps } from "@openuidev/react-lang"
import { z } from "zod/v4"

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

// Leaflet and its tiles are the heaviest code the library can reach and most replies draw no map,
// so it arrives only when one does. This module stays light: the import below is its whole claim.
const MapSurface = lazy(() => import("./map-surface.tsx"))

export const Map = defineComponent({
  name: "Map",
  props: mapProps,
  description: "Labeled places on a map; summary in words.",
  component: ({ props }: ComponentRenderProps<MapProps>) => (
    <Suspense fallback={<div className="h-56 w-full min-w-0" aria-hidden />}>
      <MapSurface props={props} />
    </Suspense>
  ),
})

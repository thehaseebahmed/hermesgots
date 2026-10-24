import { useEffect, useRef, useState } from "react"
import * as L from "leaflet"
import { HandIcon } from "lucide-react"

import { Button } from "@/components/ui/button"
import { noteFailure } from "@/lib/report"
import { useDark } from "@/lib/theme"

// The library's own stylesheet, and the tokens this surface draws its chrome with: both ride the
// lazy chunk, so a thread that draws no map downloads neither.
import "leaflet/dist/leaflet.css"
import "./map-surface.css"

import type { MapPoint, MapProps } from "./map.tsx"
import { SURFACE_FRAME } from "./surface.tsx"

/**
 * Esri's raster basemaps, served without a key: a street map in light, a dark canvas in dark, each
 * with its service's own copyrightText for the map's chrome — legal text, never explanatory copy.
 * CARTO's equally keyless pair was the first choice and is off the table — its raster endpoints
 * answer an unkeyed request with an "API key required" watermark tile (a key now needs an emailed
 * sign-in), so the map draws where it can actually draw.
 */
const BASEMAP = {
  light: {
    url: "https://server.arcgisonline.com/ArcGIS/rest/services/World_Street_Map/MapServer/tile/{z}/{y}/{x}",
    credit:
      "Sources: Esri, HERE, Garmin, USGS, Intermap, INCREMENT P, NRCan, Esri Japan, METI, " +
      "Esri China (Hong Kong), Esri Korea, Esri (Thailand), NGCC, &copy; " +
      '<a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors, ' +
      "and the GIS User Community",
  },
  dark: {
    url: "https://server.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Dark_Gray_Base/MapServer/tile/{z}/{y}/{x}",
    credit:
      "Esri, HERE, Garmin, &copy; " +
      '<a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors, ' +
      "and the GIS user community",
  },
}

/**
 * The gestures the map takes only once the reader asks it to: an untouched map must never eat the
 * thread's scroll, so dragging, wheel, pinch, double-tap, box-zoom and the keyboard all start off.
 */
const GESTURES = [
  "dragging",
  "scrollWheelZoom",
  "touchZoom",
  "doubleClickZoom",
  "boxZoom",
  "keyboard",
] as const

type Gesture = (typeof GESTURES)[number]

/** The map's options with every gesture off, read off the same list the toggle below walks. */
const GESTURES_OFF = Object.fromEntries(GESTURES.map((name) => [name, false])) as Record<
  Gesture,
  false
>

const ONE_POINT_ZOOM = 13

const FIT_PADDING_Y = 64

const LEAST_PADDING_X = 36

const LABEL_GAP = 8

const TAP_SLOP = 8

/** Every label is drawn on the map, centred on the point it names. */
const iconOf = (point: MapPoint) => {
  const span = document.createElement("span")
  // Model-written text, so it goes in as text: Leaflet appends the element itself, and a label is
  // never parsed as markup.
  span.textContent = point.label
  return L.divIcon({
    className: "openui-map-label",
    html: span,
    iconSize: [0, 0],
    iconAnchor: [0, 0],
  })
}

/**
 * Whether the block still draws the points it drew. Compared field by field rather than serialized:
 * a streaming reply re-renders this surface with every chunk, and the view may only be refitted when
 * a point actually moves.
 */
function samePoints(drawn: MapPoint[], points: MapPoint[]) {
  if (drawn === points) return true
  if (drawn.length !== points.length) return false
  return points.every((point, i) => {
    const was = drawn[i]
    return (
      was !== undefined &&
      was.lat === point.lat &&
      was.lng === point.lng &&
      was.label === point.label &&
      was.detail === point.detail
    )
  })
}

/** The fit's padding: the wider half of the widest label, and the room a point keeps above and below. */
function fitPadding(markers: L.Marker[]): [number, number] {
  const half = markers.reduce((widest, marker) => {
    const span = marker.getElement()?.querySelector("span")
    return span ? Math.max(widest, span.offsetWidth / 2) : widest
  }, 0)
  return [Math.max(LEAST_PADDING_X, Math.ceil(half) + LABEL_GAP), FIT_PADDING_Y]
}

type Box = { width: number; height: number }

/** The frame's content box: the size Leaflet lays the map out in, and the one a fit is measured at. */
const boxOf = (node: HTMLElement): Box => ({ width: node.clientWidth, height: node.clientHeight })

/**
 * Sizes the map and fits its view to the points it drew: the fit the points effect runs, and the one
 * a resize runs again. A view fitted in one box is the wrong fit in another — a rotation or a split
 * view leaves it fitted to the box it no longer has, and labels clip at the new edges.
 */
function fitView(made: L.Map, markers: L.Marker[], points: MapPoint[]) {
  if (!points.length) return
  // Sized before fitting: a block drawn while its reply was still streaming may have been created
  // at no height at all.
  made.invalidateSize()
  if (points.length === 1) {
    const [only] = points
    made.setView([only?.lat ?? 0, only?.lng ?? 0], ONE_POINT_ZOOM)
    return
  }
  made.fitBounds(L.latLngBounds(points.map((point) => [point.lat, point.lng] as L.LatLngTuple)), {
    padding: fitPadding(markers),
    maxZoom: 15,
  })
}

export default function MapSurface({ props }: { props: MapProps }) {
  const { points, summary } = props
  const theme = useDark() ? "dark" : "light"
  const [active, setActive] = useState(false)
  const frame = useRef<HTMLDivElement>(null)
  const map = useRef<L.Map | null>(null)
  const layer = useRef<L.TileLayer | null>(null)
  const markers = useRef<L.Marker[]>([])
  const drawn = useRef<MapPoint[]>([])
  const fitted = useRef<Box | null>(null)
  const pressed = useRef<{ x: number; y: number } | null>(null)

  useEffect(() => {
    const node = frame.current
    if (!node) return
    const made = L.map(node, { ...GESTURES_OFF, zoomControl: false })
    // The library credits itself in the corner; the tiles' own attribution is the one that stays.
    made.attributionControl.setPrefix(false)
    map.current = made
    return () => {
      made.remove()
      map.current = null
      layer.current = null
      markers.current = []
      drawn.current = []
    }
  }, [])

  // The basemap follows the app's theme: the one layer is re-pointed and its credit swapped in place,
  // so its tiles redraw from the browser's cache rather than a new layer being built.
  useEffect(() => {
    const made = map.current
    if (!made) return
    const basemap = BASEMAP[theme]
    const existing = layer.current
    if (!existing) {
      layer.current = L.tileLayer(basemap.url, { attribution: basemap.credit, maxZoom: 19 })
        .on("tileerror", () => noteFailure("map tiles", new Error("the basemap failed to load")))
        .addTo(made)
      return
    }
    made.attributionControl.removeAttribution(existing.getAttribution?.() ?? "")
    existing.options.attribution = basemap.credit
    made.attributionControl.addAttribution(basemap.credit)
    existing.setUrl(basemap.url)
  }, [theme])

  useEffect(() => {
    const made = map.current
    if (!made) return
    if (samePoints(drawn.current, points)) return
    drawn.current = points
    for (const marker of markers.current) marker.remove()
    markers.current = points.map((point) =>
      L.marker([point.lat, point.lng], {
        icon: iconOf(point),
        title: point.detail ?? point.label,
        keyboard: false,
      }).addTo(made),
    )
    if (!points.length) return
    fitView(made, markers.current, points)
    if (frame.current) fitted.current = boxOf(frame.current)
  }, [points])

  /**
   * A fit is measured at one box, so it is only right at that box: the thread's column changes with
   * a rotation or a split view, and a view fitted to the old one leaves its labels clipping at the
   * new edges. Only a real change re-fits — the observer's first callback reports the size the fit
   * already used, and a streamed re-render changes no size at all.
   */
  useEffect(() => {
    const node = frame.current
    if (!node) return
    const observer = new ResizeObserver(() => {
      const made = map.current
      if (!made || !drawn.current.length) return
      const box = boxOf(node)
      // A block at no size — a reply still streaming, a pane still opening — has no box to fit in.
      if (!box.width || !box.height) return
      const was = fitted.current
      if (was?.width === box.width && was?.height === box.height) return
      fitView(made, markers.current, drawn.current)
      fitted.current = boxOf(node)
    })
    observer.observe(node)
    return () => observer.disconnect()
  }, [])

  useEffect(() => {
    const made = map.current
    if (!made) return
    for (const name of GESTURES) {
      if (active) made[name].enable()
      else made[name].disable()
    }
  }, [active])

  return (
    <div className={`relative ${SURFACE_FRAME}`} data-slot="map" data-active={active}>
      <div
        ref={frame}
        role={active ? "region" : "img"}
        aria-label={summary}
        tabIndex={0}
        style={{ touchAction: active ? "none" : "pan-y" }}
        className="openui-map-frame h-full w-full"
        onPointerDown={(event) => {
          pressed.current = { x: event.clientX, y: event.clientY }
        }}
        onPointerUp={(event) => {
          const from = pressed.current
          pressed.current = null
          if (active || !from) return
          const moved = Math.hypot(event.clientX - from.x, event.clientY - from.y)
          if (moved < TAP_SLOP) setActive(true)
        }}
        onKeyDown={(event) => {
          // A key takes the map as a tap does; once it's active Leaflet's own keyboard handling has
          // it, and until then Enter or Space must not scroll the thread either.
          if (active || (event.key !== "Enter" && event.key !== " ")) return
          event.preventDefault()
          setActive(true)
        }}
      />
      {active ? (
        <Button
          type="button"
          variant="outline"
          size="icon"
          aria-label="Let the thread scroll again"
          className="absolute top-2 right-2 z-[900] size-11 rounded-md border-border bg-background/95 shadow-sm hover:bg-accent"
          onClick={() => setActive(false)}
        >
          <HandIcon aria-hidden className="size-5" />
        </Button>
      ) : null}
    </div>
  )
}

import { useEffect, useRef, useState } from "react"
import * as L from "leaflet"
import { HandIcon } from "lucide-react"
import { useTheme } from "next-themes"

// The library's own stylesheet, and the tokens this surface draws its chrome with: both ride the
// lazy chunk, so a thread that draws no map downloads neither.
import "leaflet/dist/leaflet.css"
import "./map-surface.css"

import type { MapPoint, MapProps } from "./map.tsx"

/** CARTO's free raster basemaps: a light one and a dark one, no key, no session. */
const TILES = {
  light: "https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png",
  dark: "https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png",
}

/** The tiles' terms: legal text, in the map's own chrome, never explanatory copy. */
const ATTRIBUTION =
  '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors ' +
  '&copy; <a href="https://carto.com/attributions">CARTO</a>'

/** A single point has no bounds to fit, so it takes a street-level view of its own. */
const ONE_POINT_ZOOM = 13

/**
 * Room a point keeps from the edge of the view. A label is centred on its point, so the horizontal
 * pad is the half of a label that would otherwise cross the frame.
 */
const FIT_PADDING: L.PointTuple = [36, 64]

/** A pointer that moved further than this was scrolling or dragging, not tapping. */
const TAP_SLOP = 8

const ESCAPES: Record<string, string> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#39;",
}

/** Model-written text goes into the icon's markup, so it goes in as text and never as markup. */
const escapeHtml = (text: string) =>
  text.replace(/[&<>"']/g, (character) => ESCAPES[character] ?? character)

/** Every label is drawn on the map, centred on the point it names. */
const iconOf = (point: MapPoint) =>
  L.divIcon({
    className: "openui-map-label",
    html: `<span>${escapeHtml(point.label)}</span>`,
    iconSize: [0, 0],
    iconAnchor: [0, 0],
  })

export default function MapSurface({ props }: { props: MapProps }) {
  const { points, summary } = props
  const { resolvedTheme } = useTheme()
  const dark = resolvedTheme === "dark"
  const [active, setActive] = useState(false)
  const frame = useRef<HTMLDivElement>(null)
  const map = useRef<L.Map | null>(null)
  const layer = useRef<L.TileLayer | null>(null)
  const markers = useRef<L.Marker[]>([])
  const drawn = useRef("")
  const pressed = useRef<{ x: number; y: number } | null>(null)

  useEffect(() => {
    const node = frame.current
    if (!node) return
    // Every gesture is off until the reader taps: an untouched map must never eat the thread's
    // scroll, so dragging, wheel, pinch, double-tap, box-zoom and the keyboard all start disabled.
    const made = L.map(node, {
      dragging: false,
      scrollWheelZoom: false,
      touchZoom: false,
      doubleClickZoom: false,
      boxZoom: false,
      keyboard: false,
      zoomControl: false,
    })
    // The library credits itself in the corner; the tiles' own attribution is the one that stays.
    made.attributionControl.setPrefix(false)
    map.current = made
    return () => {
      made.remove()
      map.current = null
      layer.current = null
      markers.current = []
      drawn.current = ""
    }
  }, [])

  // The basemap follows the app's theme, swapped in place: a light map in light, a dark one in dark.
  useEffect(() => {
    const made = map.current
    if (!made) return
    layer.current?.remove()
    layer.current = L.tileLayer(TILES[dark ? "dark" : "light"], {
      attribution: ATTRIBUTION,
      maxZoom: 19,
      detectRetina: true,
    }).addTo(made)
  }, [dark])

  useEffect(() => {
    const made = map.current
    if (!made) return
    // A block re-renders as its reply streams; the view may only be refitted when the points move,
    // or a reader's pan would jump back on every flush.
    const signature = JSON.stringify(points)
    if (signature === drawn.current) return
    drawn.current = signature
    for (const marker of markers.current) marker.remove()
    markers.current = points.map((point) =>
      L.marker([point.lat, point.lng], {
        icon: iconOf(point),
        title: point.detail ?? point.label,
        keyboard: false,
      }).addTo(made),
    )
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
      padding: FIT_PADDING,
      maxZoom: 15,
    })
  }, [points])

  // Active is the reader's choice, made by a tap and given back by the button: touch-handling on
  // the container follows it, so one finger scrolls the thread until the map is asked to take it.
  useEffect(() => {
    const made = map.current
    const node = frame.current
    if (!made || !node) return
    const handlers = [
      made.dragging,
      made.scrollWheelZoom,
      made.touchZoom,
      made.doubleClickZoom,
      made.boxZoom,
      made.keyboard,
    ]
    for (const handler of handlers) {
      if (!handler) continue
      if (active) handler.enable()
      else handler.disable()
    }
    node.style.touchAction = active ? "none" : "pan-y"
  }, [active])

  return (
    <div className="relative h-56 w-full min-w-0" data-slot="map" data-active={active}>
      <div
        ref={frame}
        role="img"
        aria-label={summary}
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
      />
      {active ? (
        <button
          type="button"
          aria-label="Let the thread scroll again"
          className="absolute top-2 right-2 z-[900] grid size-11 place-items-center rounded-md border border-border bg-background/95 text-foreground shadow-sm hover:bg-accent"
          onClick={() => setActive(false)}
        >
          <HandIcon aria-hidden className="size-5" />
        </button>
      ) : null}
    </div>
  )
}

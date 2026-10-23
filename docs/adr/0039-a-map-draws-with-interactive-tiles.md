# A map draws with interactive tiles

A map is the first interface that pans and zooms: it draws on real basemap tiles through Leaflet, chosen over an offline SVG world map because places read as places on streets people recognise, and pan and zoom were the point of asking for maps. The thread's scroll never suffers for it — a map ignores touch until it is tapped, then takes gestures and hands them back visibly — and the tiles follow the app's theme (a light basemap in light, a dark one in dark) with the provider's attribution in the map's chrome. The component library stays read-only as the spec says: the map is interactive as a view, never as an action.

## Considered options

- **An offline SVG world map** (d3-geo plus a small outline) — no tiles, no network, works in airplane mode, theme tokens only. Rejected because it draws places in a vacuum: no streets, no context, and pan and zoom on vector paths is the same work with less to see.
- **A static map image from a provider** — one snapshot per render. Rejected because it needs an API key and a network call for every map and still can't pan or zoom.
- **Native map gestures from the start** — rejected for the thread trap: an untouched map would swallow one-finger scroll inside a nearly full-width bubble, the exact trap the spec warns about.

## Consequences

- A drawn map needs the network to show tiles; offline it holds its markers and its summary over an empty grid, and an interface that can't draw at all stays the text it came from.
- The tile provider's terms and attribution are now part of the contract; the attribution line is legal text, not explanatory copy.
- The map's heavy code rides the same lazy boundary as the chart surface, and the chunk gate learns its marker.

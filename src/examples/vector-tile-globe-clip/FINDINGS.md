# VectorTileLayer globe clipping

`@deck.gl/carto` `VectorTileLayer` leaves diagonal blank bands when the viewport is a globe
(`_GlobeView`, or a Mapbox/MapLibre globe synced via `MapboxOverlay`). The polygons are present in
the loaded tiles — switching to Mercator draws everything with no new tile requests. CARTO ticket
sc-579024 (Cotality).

## Reproduce

`?example=vector-tile-globe-clip` — two panes share one camera:

- **1. stock** — `VectorTileLayer` as shipped (confirmed on 9.4.0, the latest release).
- **2. patched** — `PatchedVectorTileLayer`, which strips `ClipExtension` from the binary sub-layers
  on a globe viewport.

Controls: `projection` (globe | mercator), `dataset` (US counties | US states), `fill`
(translucent | opaque). Data is `carto-demo-data` via the public deck.gl-examples token (read-only).

- `projection=globe`, `fill=translucent` (default): left pane shows the diagonal blank bands; right
  pane fills — **but** look at the tile boundaries, where translucent fills now double-draw.
- `projection=mercator`: both panes are identical and complete. The bug is globe-only.
- `fill=opaque`: the right pane fills cleanly; opaque fills hide the edge overdraw.

## Mechanism

`VectorTileLayer.renderSubLayers` (`modules/carto/src/layers/vector-tile-layer.ts`) adds
`ClipExtension` to every binary tile with `clipBounds = [west, south, east, north]` (the tile's
WGS84 bbox), on `polygons-fill`, `polygons-stroke`, `linestrings`. `ClipExtension`'s fragment
shader discards fragments whose deck.gl **common-space** position falls outside clipBounds. On a
globe, common space is 3D sphere coordinates, so a tile's rectangular lng/lat bbox is not an
axis-aligned rectangle there — the straight clip planes cut across each tile at an angle, which is
the diagonal bands (~40% of every tile).

The base `MVTLayer` only adds its own `ClipExtension` when `!this.context.viewport.resolution`
(i.e. not a globe); `VectorTileLayer` never got that guard.

## Why ClipExtension is there (don't just delete it)

The clip is **not** picking de-dup. MVT/binary tile geometry is buffered *past* the tile edge, so
adjacent tiles overlap at the shared boundary. Without the clip, that overlap double-draws:
translucent fills get a darker seam and strokes draw twice along every tile border. The clip
removes those boundary artifacts.

History (visgl/deck.gl):

- **#4336** (`201125eb7`) — original `ClipExtension`, added to MVT rendering to remove tile-boundary
  artifacts. Follow-up of **#3935** ("avoiding border in represented geometries when clipped by tile
  limits").
- **#8167** (`1d7207dc4`) — ClipExtension carried into `@deck.gl/carto` VectorTileLayer (v9 port).
- **#9060** (`7ad027d22`) + issue **#9059** — restrict the clip to polygon/line sub-layers; points
  are excluded (a point either belongs to the tile or doesn't, and clipping them hit a shader
  accuracy bug).
- **#9075** (`3f1d8dac0`) — `applyClipExtensionToSublayerProps` refactor (no semantic change).
- **#4961** (`bd88fcb2d`) — the precedent: MVTLayer skips the clip on globe because it renders tiles
  in WGS84 there, not local Cartesian tile space. **#6743** (`4571c0b77`) — MVTLayer also forces
  `binary:false` on globe; VectorTileLayer forces `binary:true` regardless.

## Fix options

1. **Mirror MVTLayer** — gate the clip behind `!this.context.viewport.resolution`. One line, matches
   the existing MVTLayer precedent, but accepts the tile-edge overdraw on globe (visible on
   translucent fills — see the `fill=translucent` pane here).
2. **Globe-correct clip** — clip against the tile bbox in the globe's common space instead of
   assuming an axis-aligned rectangle. Larger change, but keeps the overdraw protection on globe.

`PatchedVectorTileLayer` here implements option 1 to isolate the bug; it is not proposed as the
final fix.

# VectorTileLayer globe clipping

`@deck.gl/carto` `VectorTileLayer` leaves diagonal blank bands when the viewport is a globe
(`_GlobeView`, or a Mapbox/MapLibre globe synced via `MapboxOverlay`). The polygons are present in
the loaded tiles — switching to Mercator draws everything with no new tile requests. CARTO ticket
sc-579024 (Cotality).

## Reproduce

`?example=vector-tile-globe-clip` — three panes share one camera:

- **1. stock** — `VectorTileLayer` as shipped (confirmed on 9.4.0, the latest release).
- **2. method 1** — `PatchedVectorTileLayer`, which strips `ClipExtension` from the binary sub-layers
  on a globe viewport. Fills, but drops the overdraw protection (visible on translucent fills).
- **3. method 2** — `GlobeAwareVectorTileLayer`, which *keeps* clipping on a globe but swaps the
  flat-only `ClipExtension` for `GlobeClipExtension` (clips in lng/lat space). Fills **and** keeps
  the overdraw protection. Draft of the cheap variant (lng/lat `worldPosition` — fp32, precision
  degrades at high zoom, deck #9059); the precise variant inverse-maps `position.xyz` to lng/lat.

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

`PatchedVectorTileLayer` here implements option 1 to isolate the bug; `GlobeAwareVectorTileLayer`
implements option 2 (pane 3), switchable between the two sub-variants below.

## Fragment-shader cost (method 2)

The clip runs in `DECKGL_FILTER_COLOR` on `polygons-fill` / `polygons-stroke` / `linestrings`.
Heavy = transcendental / sqrt / div (SFU ops, ~1/4–1/8 ALU throughput); comparisons are free.

| variant | per-vertex heavy | per-fragment heavy | precision |
|---|---|---|---|
| stock | 0 | 0 (4 cmp) | broken on globe |
| method 2 — **fp32** (`GlobeClipExtension`) | 0 | 0 (4 cmp) | fp32 lng/lat; degrades at high zoom (#9059) |
| method 2 — **precise** (`GlobeClipExtensionPrecise`) | 0 | ~4 (`atan2`, `asin`, `sqrt`, `div`) | safe |
| upstream **#10659** | ~3 (`log`, `atan`, `sqrt` in the vs flatten) | 0 (4 cmp) | safe + antimeridian |

- **fp32 ≈ stock** — same box test on a different varying; no measurable cost.
- **precise** adds ~4 SFU ops *per fragment*. Polygon fills cover large areas (many fragments), so
  on big translucent fills on a weak GPU it's the costly case — order tens of cycles/fragment added
  to an otherwise light fill shader. Negligible on desktop at map resolutions; measurable on mobile.
- **#10659 does the heavy transform per-vertex** (flatten `geometry.position` → mercator-common in
  the vs, interpolate, box-test in the fs). Vertices ≪ fragments, so per-fragment cost is ~free —
  precise *and* cheap. Our precise variant could do the same (move the inverse to the vs); kept
  per-fragment here only to make the method obvious.

## Upstream fix (this is being solved in deck.gl)

- **#10657** (`ba162619e`, merged to master) — flat common-space helpers
  (`project_common_position_to_flat_wrapped`) in the project module. **Not in 9.4.0.**
- **#10659** (open) — `fix(extensions): ClipExtension geometry mode in GlobeView`. Exactly option 2,
  in `ClipExtension` itself: vs flattens the sphere position to mercator-common, `draw()` sets
  bounds via `projectBoundsToFlatCommon`, antimeridian-wrapped. Depends on #10657.
- **#10727** (open, draft) — `fix(geo-layers): clip MVTLayer sub layers under GlobeView`. The
  MVTLayer analog (MVTLayer *skips* the clip on globe, so it must re-add it); requires #10659.

**For sc-579024 (CARTO `VectorTileLayer`): #10659 alone fixes it, with no CARTO change.** Our layer
already applies geometry-mode `ClipExtension` with the lng/lat tile bbox on globe — once #10659 makes
that primitive globe-correct, the existing clip just works. #10727 is for MVTLayer, not us. The two
panes here are a working preview of #10659 on 9.4.0 today (the precise variant is constant-free, so
it needs none of #10657's helpers).

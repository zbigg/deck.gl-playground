# deck.gl playground

A small React + Vite + deck.gl sandbox for isolating rendering experiments. Each experiment
lives under `src/examples/`; add more to the registry in `src/App.tsx`.

```bash
npm install
npm run dev
```

## Example: fill-pattern-hacks

Renders Natural Earth countries with a CARTO fill pattern (deck.gl `FillStyleExtension`) and a
[leva](https://github.com/pmndrs/leva) panel that toggles every pattern-rendering fix **live**,
so you can see exactly which one fixes what, at any zoom. The pattern atlas + extension are
ported from `@carto/api-client` / CARTO Builder; the pattern tiles are the real catalog.

The fixes address problems in **opposite zoom regimes**:

| Control | Regime | Problem it addresses |
|---|---|---|
| `lodMaxClamp (mips)` | zoomed **out** (minification) | Moiré/shimmer when a repeat shrinks toward a pixel. `0` = mipmaps off (deck default). |
| `margin mip levels` | — | atlas bleeding-buffer width; keep ≥ `lodMaxClamp` so mip levels stay bleed-free. |
| `seam fix (#7326)` | zoomed **out** (with mips) | the `mod()`-boundary seam mipmapping introduces on an atlas; `textureGrad` LOD from the continuous coord. |
| `fp64 origin` | zoomed **in** (~z15+) | fp32 precision collapse of the world-anchored pattern phase; reduce the origin mod scale on the CPU in fp64. |
| `sizing` | — | `World anchored` (fixed geo size → minifies when zoomed out) vs `Follow zoom` (fixed screen size → no minification, so mips/seam become moot). |
| `pattern` / `cellSize` / `assetSource` | — | which tile (diagonal vs hatch behave differently), atlas resolution, tile source. |

Suggested passes:

- **Moiré:** `World anchored`, zoom to z5–8, flip `lodMaxClamp` 0 → 4 (Moiré fades); flip `seam fix` to kill the boundary seam.
- **High-zoom precision:** any sizing, zoom to z16–20, flip `fp64 origin` — the pattern stops disintegrating.
- **Does sizing obviate mips?** switch to `Follow zoom` and confirm minification (and the need for mips) never occurs.

## Example: dense-buildings

The high-zoom precision question on its own, on the geometry that actually shows it: ~1100 OSM
building footprints in Park Slope, Brooklyn (row houses, median ~88 m²), a dense repeat, and
z17-18 — where one building is 8-20 screen pixels across.

Three panes, one shared camera, one layer each:

1. **stock deck.gl** — `FillStyleExtension` as shipped.
2. **POC (shader fp64)** — `CartoFillStyleExtension({fp64: true})`: reduces the origin on the
   CPU, then re-splits it into an fp32 hi/lo pair the shader recombines.
3. **CPU phase (no fp64)** — reduces the origin on the CPU and stops there. No 64-bit low part,
   no fp64 emulation in the shader.

### Why fp64 in the shader is unnecessary

deck's fragment shader anchors the pattern with

```glsl
mod(mod(uvCoordinateOrigin, scale) + uvCoordinateOrigin64Low + fill_uv, scale)
```

`uvCoordinateOrigin` is the common-space position of the projection origin — up to 512 (the
whole world). `scale` is one pattern repeat, ~1e-5 common units at z18. Reducing one against
the other in fp32 is where the precision goes: `scale * floor(origin / scale)` rounds to ~1e-5
common units, which is a few screen pixels of phase error past z16 — and past a whole repeat
once the repeat is that small.

But `origin mod scale` is a function of two numbers JS already holds at full precision, and
subtracting whole multiples of `scale` does not change the phase. Do it in JS and the shader
receives a value already smaller than one repeat, which fp32 resolves to ~1e-11 common units.
There is nothing left for a low part to correct.

The shader does not even need editing for this: `mod(x, y)` returns `x` exactly when
`0 <= x < y`, so pre-reducing the uniform makes deck's existing expression exact and the
`uvCoordinateOrigin64Low` term identically zero. Pane 3 drops the term anyway, to make the
point that it is dead weight.

**The one constraint:** `scale` is per-instance in the shader (`fillPatternScales` × the frame
size) while the origin is a uniform, so a single CPU reduction is only valid when every
instance agrees on the repeat. `patternCellCommon()` returns `null` otherwise and the
extension leaves deck's path alone.

### Reading it

The label on each pane shows that pane's predicted phase error in screen pixels (computed by
replaying the shader's arithmetic in fp32 via `Math.fround`, against the fp64 answer), next to
the repeat size in the status bar — a 2 px error on a 12 px repeat is a sixth of a cell.

The loupe docked under the panes samples all three at the same pane-local pixel, so one hover
compares the same building rendered three ways. `freeze` holds the last sample while you move
the mouse away.

Watch the numbers while you pan: pane 1's error moves with the camera (that is the artifact —
the pattern re-phases against the buildings), panes 2 and 3 stay at ~1e-7 px.

> Software GL (SwiftShader, `--use-gl=swiftshader`, most headless CI) computes `mod()` more
> precisely than a real fp32 GPU and under-reports the difference. Look at this on hardware.

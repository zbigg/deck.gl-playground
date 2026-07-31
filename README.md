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

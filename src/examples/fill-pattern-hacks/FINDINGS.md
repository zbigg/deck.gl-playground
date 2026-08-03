# Fill Pattern — Findings

Port target: **carto-api-client** (atlas gen) + **cloud-native** (Builder / FillStyleExtension).

## TL;DR

Ship: **one tile per cell + render resolution**, **seam fix + fp64 BOTH on**, **mip levels 4**, **SVG re-exported @2 (128px)**. Moiré = texture minification aliasing (not MSAA's job): keep **mips on always** (≈free); reach for **anisotropy 4–8× only when tilted** (free when flat, the only knob that can cost you). **Best-looking default combo from the matrix: `lodMaxClamp 2` + `maxAnisotropy 4`** — crisp with moiré well-suppressed.

## 1. SVG quality = resolution, not tile-repeat

- Old: pack NxN copies of 64px tile into big cell. More texels, SAME per-tile density → NOT sharper. Trap.
- New: **one tile per cell, rendered at chosen texel resolution**. `cell = 64 * res`.
- Resolution = fidelity ONLY. Must not move on-screen size.
- `patternScale = onScreenBase * (64 / resolution)`. The `64/res` cancels shader `* frame.width` → size invariant across res.
- PNG frozen at 64 (raster). SVG/procedural render crisp at any res.
- Drop `scaleAdjustment` / `reps`. Move `64/res` into pattern scale.

## 2. Seam fix + fp64 — BOTH required

- **seam (#7326)**: mip + `mod()`-REPEAT emulation spikes texCoord derivative at tile edge → too-coarse mip → seam. Fix: `textureGrad`, LOD from continuous coord.
- **fp64**: world-anchored origin `mod` loses fp32 precision high zoom (~z15+) → pattern dies. Fix: reduce origin mod-scale on CPU in fp64, feed residual.
- seam alone → breaks high zoom. fp64 alone → seams once mips on. Need both.

## 3. Mip levels = 4

- margin = `2^levels` texels, capped `cell/4`. levels=4 → clean minification, no bleed, good zoom-out. Sweet spot.

## 4. SVG re-exported @2 = best

- Real figma tiles = seamless line art. Spec: spacing 16/8/4 (large/med/small), line width 2.
- Diagonals must fit integer periods that divide 64 → **n = 12/6/3** (else seam).
- Export svg @2 (128 texels) = crisp + correct density. Beats png (64 fixed) on hiDPI.
- Per-tile svg = viewBox-crop of figma export, keep mask/clip (no bleed).

## 5. Moiré: it's texture minification aliasing (not an edge problem)

- Moiré appears zoomed-out = pattern spatial frequency exceeds screen-pixel (Nyquist) frequency, in the fill **interior**.
- MSAA does NOT help: it multisamples geometry-edge coverage only; the shader still samples the pattern once per fragment. Wrong tool.
- The right levers all raise the *effective texture sampling rate*: **mipmaps** (prefilter), **anisotropy** (multi-tap), **SSAA/higher DPR** (supersample the fragment).

## 6. Anisotropic filtering (`maxAnisotropy`)

- Interacts with mips: picks a **finer LOD** keyed to the footprint's *minor* axis, then takes **N trilinear taps** along the *major* axis. Needs mips available to bite (`lodMaxClamp` > 0).
- Only differs from plain trilinear when the footprint is **elongated** — i.e. at a **grazing angle**. On a flat top-down map (pitch 0) the footprint is square (`major/minor ≈ 1`) → aniso ≡ trilinear, **no visible difference**. Must tilt to see it.
- Wins vs mips-only: kills minification moiré with **far less crispness loss** (mips over-blur the minor axis; aniso keeps it sharp).
- **Winner from the matrix: `lodMaxClamp 2` + `maxAnisotropy 4`** — best crispness↔moiré balance; now the demo defaults.

## 7. Performance

- **Mips/LOD: ~free, often a net win.** Trilinear ≈ 2× texel reads of bilinear, but `lodMaxClamp` value doesn't change that. Minified sampling has better texture-cache coherence → frequently *faster* than full-res. +33% texture memory. Leave on always.
- **Anisotropy: the only costly knob, but adaptive.** Up to N trilinear taps → ~N× fetch bandwidth, BUT only as many taps as the real footprint ratio needs. Flat view (ratio≈1) = ~free even at 16×; grazing angle = ramps to N× on the elongated fragments only. Cost ∝ grazing-screen-area × ratio × N. **Sweet spot 4–8×**; 16× rarely worth it. **DPR compounds it** (more fragments).
- **In the real map**: sampler cost is minor vs deck's usual bottlenecks (draw calls, geometry, fill rate). Measure before worrying.

## 8. Comparison harness (matrix dataset + 3D)

- **`LOD×aniso matrix` dataset**: synthetic 5×5 grid of quads centered on (0,0), ~2/3 of the world; one layer per (`lodMaxClamp`, `maxAnisotropy`) combo, identical FSE otherwise. Big quads at whole-world zoom = heavy minification = moiré regime by default.
- **`3D (tilt)` toggle** (44°, unlocks pitch/bearing) is required to compare the anisotropy columns — flat = all columns identical.
- NB the matrix's own frame rate is dominated by **25 layers / 25 draw calls / 25 atlas-texture copies**, not the sampler — don't read it as representative.
- Cell labels drawn with depth test/write off so they don't sink into tilted quads.

## Port plan

**carto-api-client** (pattern atlas gen — asset-source / mipmap-margins modules):
- one tile per cell; `resolution` param, default 128 (@2) for svg.
- seamless diagonal geometry (n=12/6/3, width 2).
- drop `scaleAdjustment`; expose native tile size (64) for the scale formula.

**cloud-native** (Builder FillStyleExtension + wiring):
- land seam (#7326) + fp64 shader patches, both default on.
- default mip levels 4.
- pattern scale = base * (64 / resolution).
- png locked to 64; svg/procedural use resolution knob.

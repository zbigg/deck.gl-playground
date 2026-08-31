// Predicts, in JS, how far off the pattern phase is in each of the three panes — the same
// arithmetic the fragment shader does, replayed in fp32 via Math.fround, against the fp64
// answer. Lets the demo put a number next to what the loupe is showing.

const WORLD = 512; // deck's common space spans 512 units for the whole world

// GLSL mod(x, y) = x - y * floor(x / y), every step rounded to fp32.
const f = Math.fround;
const glslMod = (x: number, y: number) => f(f(x) - f(f(y) * Math.floor(f(f(x) / f(y)))));

const fp64LowPart = (x: number) => x - f(x);

const lngToCommon = (lng: number) => (WORLD * (lng + 180)) / 360;
const latToCommon = (lat: number) =>
  (WORLD * (1 - Math.log(Math.tan(Math.PI / 4 + (lat * Math.PI) / 360)) / Math.PI)) / 2;

// Circular distance between two phases, expressed in screen pixels.
function phaseErrorPx(got: number, truth: number, cell: number, commonPerPixel: number): number {
  const d = Math.abs(got - truth);
  return Math.min(d, cell - d) / commonPerPixel;
}

export type PhaseError = { stock: number; fp64: number; nofp64: number };

/**
 * Phase error per variant, in screen pixels, for the current camera.
 *
 * Above z12 deck switches to auto-offset mode and the projection origin is the viewport
 * centre, so that is the value the shader has to reduce against the pattern cell. Below z12
 * the origin is a constant and the large term moves into the (interpolated) vertex offset
 * instead — out of reach of any of the three, so report the reducible part only.
 */
export function phaseErrors(opts: {
  longitude: number;
  latitude: number;
  zoom: number;
  cellCommon: number;
}): PhaseError {
  const { longitude, latitude, zoom, cellCommon: cell } = opts;
  const commonPerPixel = 1 / 2 ** zoom;

  const worst = { stock: 0, fp64: 0, nofp64: 0 };
  // deck fround()s the origin's lng/lat before projecting it (getOffsetOrigin).
  for (const origin of [lngToCommon(f(longitude)), latToCommon(f(latitude))]) {
    // `origin` is the full-precision common origin — the value getUniforms() hands out. deck
    // splits it into these two only on the way to the uniform buffer.
    const hi = f(origin);
    const lo = fp64LowPart(origin);
    const truth = ((origin % cell) + cell) % cell;

    // 1. stock: mod(mod(hi, cell) + lo, cell), all in fp32
    const stock = glslMod(f(glslMod(hi, cell) + f(lo)), cell);
    // 2. POC: reduces `origin + low` — but `origin` is already the full value, so the low part
    // is counted twice. `lo` is a sawtooth in `origin` (it resets at every fp32 grain), which
    // puts a grain-sized step back into the phase, exactly what the reduction was for.
    const reduced = (origin + lo) % cell;
    const poc = glslMod(f(f(reduced) + f(fp64LowPart(reduced))), cell);
    // 3. CPU phase: reduce the full value once, and stop.
    const cpu = f(truth);

    worst.stock = Math.max(worst.stock, phaseErrorPx(stock, truth, cell, commonPerPixel));
    worst.fp64 = Math.max(worst.fp64, phaseErrorPx(poc, truth, cell, commonPerPixel));
    worst.nofp64 = Math.max(worst.nofp64, phaseErrorPx(cpu, truth, cell, commonPerPixel));
  }
  return worst;
}

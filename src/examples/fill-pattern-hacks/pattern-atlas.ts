// Fill-pattern atlas — ported from @carto/api-client's fetch-map/pattern-atlas, trimmed to
// what the playground needs and parameterized by live controls (cell size, mip-level margin,
// asset source) instead of localStorage knobs. The real CARTO pattern tiles are vendored
// under ./patterns; the procedural painters are kept as an asset-free comparison.

// deck's meters -> common-space constant (mirrors FILL_UV_SCALE in the fill shader).
export const FILL_UV_SCALE = 512 / 40_000_000;

const SOURCE_TILE_SIZE = 64; // native period of every tile — png raster is 64×64, svg viewBox is 0 0 64 64

export type PatternAssetSource = 'png' | 'svg' | 'procedural';

export const PATTERN_ROWS = [
  'hlines',
  'vlines',
  'diag-left',
  'diag-right',
  'cross-hatch',
  'dots',
  'checker'
] as const;
const DENSITY_COLUMNS = ['large', 'medium', 'small'] as const;

export type PatternKey = `${(typeof PATTERN_ROWS)[number]}-${(typeof DENSITY_COLUMNS)[number]}`;
export const PATTERN_KEYS: PatternKey[] = PATTERN_ROWS.flatMap((row) =>
  DENSITY_COLUMNS.map((d) => `${row}-${d}` as PatternKey)
);

export type PatternFrame = { x: number; y: number; width: number; height: number };
export type PatternMapping = Record<string, PatternFrame>;

// Vendored catalog, imported by Vite as URLs. Keyed by "<pattern>-<density>" / "solid".
const asKey = (path: string) => path.replace(/^.*\//, '').replace(/\.(png|svg)$/, '');
const pngUrls = import.meta.glob('./patterns/*.png', { eager: true, query: '?url', import: 'default' });
const svgUrls = import.meta.glob('./patterns/*.svg', { eager: true, query: '?url', import: 'default' });
const CELL_PNG: Record<string, string> = {};
const CELL_SVG: Record<string, string> = {};
for (const [p, url] of Object.entries(pngUrls)) CELL_PNG[asKey(p)] = url as string;
for (const [p, url] of Object.entries(svgUrls)) CELL_SVG[asKey(p)] = url as string;

// Every source shares the same 64px native period, so density is source-independent.
const repeatsFor = (cell: number) => Math.max(1, Math.floor(cell / SOURCE_TILE_SIZE));

// Keeps the on-screen pattern size constant across cell sizes.
export const scaleAdjustment = (cell: number) => (SOURCE_TILE_SIZE * repeatsFor(cell)) / cell;

// Margin (bleeding buffer) sized as 2^levels texels so `levels` mip levels stay bleed-free,
// capped at cell/4. Filled with the cell's own wrapped pattern by composeAtlas.
const cellPadding = (cell: number, mipLevels: number) => Math.max(2, Math.min(1 << mipLevels, Math.round(cell / 4)));

export function getAtlasMapping(cell: number, mipLevels: number): PatternMapping {
  const pad = cellPadding(cell, mipLevels);
  const pitch = cell + 2 * pad;
  const mapping: PatternMapping = {};
  const frame = (col: number, row: number): PatternFrame => ({
    x: pad + col * pitch,
    y: pad + row * pitch,
    width: cell,
    height: cell
  });
  PATTERN_ROWS.forEach((pattern, row) => {
    DENSITY_COLUMNS.forEach((density, col) => {
      mapping[`${pattern}-${density}`] = frame(col, row);
    });
  });
  mapping.none = frame(0, PATTERN_ROWS.length);
  mapping.solid = frame(1, PATTERN_ROWS.length);
  return mapping;
}

type AnyCanvas = HTMLCanvasElement | OffscreenCanvas;
type Ctx = OffscreenCanvasRenderingContext2D | CanvasRenderingContext2D;

function createCanvas(w: number, h: number): AnyCanvas {
  if (typeof OffscreenCanvas !== 'undefined') return new OffscreenCanvas(w, h);
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  return c;
}

function loadRaster(url: string): Promise<CanvasImageSource> {
  return fetch(url)
    .then((r) => r.blob())
    .then((b) => createImageBitmap(b));
}

function loadSvg(url: string): Promise<CanvasImageSource> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = reject;
    img.src = url;
  });
}

const DENSITY_STEP: Record<string, number> = { small: 1, medium: 2, large: 4 };

function paintTile(ctx: Ctx, key: string): void {
  const [, name, density] = key.match(/^(.*?)(?:-(small|medium|large))?$/) ?? [];
  const step = DENSITY_STEP[density ?? ''] ?? 1;
  const linePeriod = 4 * step;
  const diagPeriod = (16 * step) / 3; // 45° lines: 12/6/3 periods across the 64px tile (divides 64 → seamless)
  const square = 2 * step;
  ctx.fillStyle = '#000';
  ctx.strokeStyle = '#000';
  const diag = (dir: 1 | -1) => {
    ctx.lineWidth = 2;
    ctx.beginPath();
    for (let k = -Math.ceil(64 / diagPeriod); k <= 2 * Math.ceil(64 / diagPeriod); k++) {
      ctx.moveTo(k * diagPeriod - 8 * dir, -8);
      ctx.lineTo(k * diagPeriod + 72 * dir, 72);
    }
    ctx.stroke();
  };
  switch (name) {
    case 'solid':
      ctx.fillRect(0, 0, 64, 64);
      break;
    case 'hlines':
      for (let y = 0; y < 64; y += linePeriod) ctx.fillRect(0, y, 64, 2);
      break;
    case 'vlines':
      for (let x = 0; x < 64; x += linePeriod) ctx.fillRect(x, 0, 2, 64);
      break;
    case 'dots':
      for (let y = 0; y < 64; y += linePeriod) for (let x = 0; x < 64; x += linePeriod) ctx.fillRect(x, y, 2, 2);
      break;
    case 'checker':
      for (let j = 0; j * square < 64; j++)
        for (let i = 0; i * square < 64; i++) if ((i + j) % 2 === 0) ctx.fillRect(i * square, j * square, square, square);
      break;
    case 'diag-left':
      diag(-1);
      break;
    case 'diag-right':
      diag(1);
      break;
    case 'cross-hatch':
      diag(1);
      diag(-1);
      break;
  }
}

function paintTileCanvas(key: string, size: number): CanvasImageSource {
  const c = createCanvas(size, size);
  const ctx = c.getContext('2d') as Ctx;
  ctx.scale(size / 64, size / 64);
  paintTile(ctx, key);
  return c as unknown as CanvasImageSource;
}

export type AssembledAtlas = ImageBitmap | HTMLCanvasElement;

// Composite the tiles onto the atlas grid; each cell is filled with reps x reps copies plus
// enough extra rings to fill the whole margin with the pattern's wrapped content.
async function composeAtlas(
  cell: number,
  mipLevels: number,
  reps: number,
  images: Record<string, CanvasImageSource>
): Promise<AssembledAtlas> {
  const mapping = getAtlasMapping(cell, mipLevels);
  const pad = cellPadding(cell, mipLevels);
  const pitch = cell + 2 * pad;
  const step = cell / reps;
  const canvas = createCanvas(pitch * 3, pitch * (PATTERN_ROWS.length + 1));
  const ctx = canvas.getContext('2d') as Ctx;

  for (const [key, frame] of Object.entries(mapping)) {
    const img = images[key];
    if (!img) continue;
    ctx.save();
    ctx.beginPath();
    ctx.rect(frame.x - pad, frame.y - pad, cell + 2 * pad, cell + 2 * pad);
    ctx.clip();
    const ext = Math.ceil(pad / step);
    for (let i = -ext; i < reps + ext; i++) {
      for (let j = -ext; j < reps + ext; j++) {
        ctx.drawImage(img, frame.x + i * step, frame.y + j * step, step, step);
      }
    }
    ctx.restore();
  }

  if (typeof createImageBitmap !== 'undefined') return createImageBitmap(canvas as HTMLCanvasElement);
  return canvas as HTMLCanvasElement;
}

export type AtlasBuild = {
  atlas: Promise<AssembledAtlas>;
  mapping: PatternMapping;
  scaleAdjustment: number;
  cell: number;
};

export function buildAtlas(opts: {
  cellSize: number;
  mipLevels: number;
  assetSource: PatternAssetSource;
}): AtlasBuild {
  const { cellSize: cell, mipLevels, assetSource } = opts;
  const reps = repeatsFor(cell);
  const step = cell / reps;

  const atlas = (async () => {
    const images: Record<string, CanvasImageSource> = {};
    if (assetSource === 'procedural') {
      for (const key of [...PATTERN_KEYS, 'solid']) images[key] = paintTileCanvas(key, step);
    } else {
      const urls = assetSource === 'png' ? CELL_PNG : CELL_SVG;
      const load = assetSource === 'png' ? loadRaster : loadSvg;
      await Promise.all(Object.entries(urls).map(async ([key, url]) => (images[key] = await load(url))));
    }
    return composeAtlas(cell, mipLevels, reps, images);
  })();

  return { atlas, mapping: getAtlasMapping(cell, mipLevels), scaleAdjustment: scaleAdjustment(cell), cell };
}

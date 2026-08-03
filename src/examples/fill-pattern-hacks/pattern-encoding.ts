// Data-driven fill-pattern encodings for the USA-states demo.
//
// Patterns are a categorical visual variable, so a column drives `getFillPattern` in
// one of two ways:
//   - ordinal / quantitative  → magnitude maps to texture DENSITY of one family
//                               (sparse `large` spacing → dense `small` spacing)
//   - nominal / categorical   → each category maps to a distinct pattern SHAPE (family)
import { PATTERN_ROWS, type PatternKey } from './pattern-atlas';

export type Feature = { properties?: Record<string, unknown> };

// 'fixed' = keep the single-pattern leva behavior. The rest are columns in the states file.
export type PatternColumn = 'fixed' | 'unemp_rate' | 'hh_med_inc' | 'total_pop' | 'name_alt';

export const NUMERIC_COLUMNS = ['unemp_rate', 'hh_med_inc', 'total_pop'] as const;
export const isNumericColumn = (c: PatternColumn): boolean =>
  (NUMERIC_COLUMNS as readonly string[]).includes(c);

export const PATTERN_COLUMN_LABELS: Record<PatternColumn, string> = {
  fixed: 'Fixed (single pattern)',
  unemp_rate: 'unemp_rate — density',
  hh_med_inc: 'hh_med_inc — density',
  total_pop: 'total_pop — density',
  name_alt: 'name_alt — shape (categorical)'
};

// One family carries the ordinal ramp; low→high magnitude = sparse→dense.
const ORDINAL_FAMILY = 'diag-right';
const DENSITY_RAMP: PatternKey[] = [
  `${ORDINAL_FAMILY}-large`, // sparsest — lowest class
  `${ORDINAL_FAMILY}-medium`,
  `${ORDINAL_FAMILY}-small` // densest — highest class
];

export type LegendEntry = { pattern: PatternKey; label: string };
export type Encoding = { getPattern: (f: Feature) => PatternKey; legend: LegendEntry[] };

const FALLBACK: PatternKey = 'hlines-medium';

// Compact human labels: 5.9M / 74k / 8.0.
function fmt(v: number): string {
  if (!Number.isFinite(v)) return '—';
  if (Math.abs(v) >= 1e6) return `${(v / 1e6).toFixed(1)}M`;
  if (Math.abs(v) >= 1e4) return `${Math.round(v / 1e3)}k`;
  return v.toFixed(1);
}

// Tertile breaks over the finite values — 3 balanced classes.
function tertileBreaks(values: number[]): [number, number] {
  const xs = values.filter(Number.isFinite).sort((a, b) => a - b);
  if (!xs.length) return [0, 0];
  const q = (p: number) => xs[Math.min(xs.length - 1, Math.floor(p * xs.length))];
  return [q(1 / 3), q(2 / 3)];
}

function numericEncoding(column: string, features: Feature[]): Encoding {
  const [b1, b2] = tertileBreaks(features.map((f) => Number(f.properties?.[column])));
  const classify = (v: number) => (v < b1 ? 0 : v < b2 ? 1 : 2);
  const getPattern = (f: Feature) => {
    const v = Number(f.properties?.[column]);
    return Number.isFinite(v) ? DENSITY_RAMP[classify(v)] : FALLBACK;
  };
  const legend: LegendEntry[] = [
    { pattern: DENSITY_RAMP[0], label: `< ${fmt(b1)}` },
    { pattern: DENSITY_RAMP[1], label: `${fmt(b1)} – ${fmt(b2)}` },
    { pattern: DENSITY_RAMP[2], label: `≥ ${fmt(b2)}` }
  ];
  return { getPattern, legend };
}

// name_alt looks like "DE|Del." — key on the leading token.
const catKey = (raw: unknown) => String(raw ?? '?').split('|')[0].trim();

function categoricalEncoding(column: string, features: Feature[]): Encoding {
  const cats = [...new Set(features.map((f) => catKey(f.properties?.[column])))].sort();
  const patternFor = (i: number) => `${PATTERN_ROWS[i % PATTERN_ROWS.length]}-medium` as PatternKey;
  const map = new Map<string, PatternKey>(cats.map((c, i) => [c, patternFor(i)]));
  const getPattern = (f: Feature) => map.get(catKey(f.properties?.[column])) ?? FALLBACK;
  const legend: LegendEntry[] = cats.map((c) => ({ pattern: map.get(c)!, label: c }));
  return { getPattern, legend };
}

// Build the encoding for `column` over the loaded `features`. `fixedPattern` is used
// verbatim in 'fixed' mode (no data lookup).
export function buildEncoding(column: PatternColumn, features: Feature[], fixedPattern: PatternKey): Encoding {
  if (column === 'fixed') return { getPattern: () => fixedPattern, legend: [] };
  if (column === 'name_alt') return categoricalEncoding(column, features);
  return numericEncoding(column, features);
}

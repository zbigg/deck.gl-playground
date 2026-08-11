import { useEffect, useMemo, useRef, useState } from 'react';
import DeckGL from '@deck.gl/react';
import { Map } from 'react-map-gl/maplibre';
import { GeoJsonLayer } from '@deck.gl/layers';
import { FillStyleExtension } from '@deck.gl/extensions';
import type { Layer, LayerExtension, MapViewState } from '@deck.gl/core';
import { useControls } from 'leva';
import 'maplibre-gl/dist/maplibre-gl.css';
import {
  buildAtlas,
  FILL_UV_SCALE,
  PATTERN_KEYS,
  SOURCE_TILE_SIZE,
  type AtlasBuild,
  type PatternAssetSource
} from '../fill-pattern-hacks/pattern-atlas';
import { CartoFillStyleExtension } from '../fill-pattern-hacks/CartoFillStyleExtension';
import { NoFp64FillStyleExtension } from './NoFp64FillStyleExtension';
import { MultiLoupe, type LoupeCursor, type LoupePane } from './MultiLoupe';
import { phaseErrors } from './phase-error';
import buildingsData from './buildings.json';
import type { FeatureCollection, Polygon } from 'geojson';

const buildings = buildingsData as FeatureCollection<Polygon, { id: number }>;

// ~1100 OSM building footprints in Park Slope, Brooklyn — row houses, median ~88 m², so at
// z17-18 a single building is 8-20 screen px across. Small features + a dense repeat is the
// regime where the pattern phase math has to be exact to look like anything at all.
const INITIAL_VIEW_STATE: MapViewState = { longitude: -73.9843, latitude: 40.67174, zoom: 17.5 };

const CARTO_STYLES: Record<string, string> = {
  positron: 'https://basemaps.cartocdn.com/gl/positron-gl-style/style.json',
  'dark-matter': 'https://basemaps.cartocdn.com/gl/dark-matter-gl-style/style.json',
  voyager: 'https://basemaps.cartocdn.com/gl/voyager-gl-style/style.json'
};

const COLOR_PALETTE: [number, number, number][] = [
  [136, 46, 114],
  [25, 101, 176],
  [123, 65, 20],
  [153, 0, 13],
  [74, 20, 134],
  [0, 68, 27],
  [39, 100, 25],
  [103, 0, 31]
];

const VARIANTS = [
  { key: 'stock', label: '1. stock deck.gl' },
  { key: 'fp64', label: '2. POC (shader fp64)' },
  { key: 'nofp64', label: '3. CPU phase (no fp64)' }
] as const;

const STORE_KEY = 'deckgl-playground:dense-buildings';
type Persisted = { controls?: Record<string, unknown>; viewState?: MapViewState };

function loadPersisted(): Persisted {
  try {
    const parsed = JSON.parse(localStorage.getItem(STORE_KEY) ?? '{}');
    return { ...parsed, viewState: sanitizeViewState(parsed.viewState) };
  } catch {
    return {};
  }
}

// Storing the raw viewState deck emits during interaction can round-trip a dead
// transitionInterpolator (class instance -> {}), which wedges the controller on reload.
function sanitizeViewState(vs: unknown): MapViewState | undefined {
  if (!vs || typeof vs !== 'object') return undefined;
  const { longitude, latitude, zoom, pitch, bearing } = vs as Record<string, unknown>;
  if (![longitude, latitude, zoom].every((n) => typeof n === 'number' && Number.isFinite(n))) return undefined;
  return { longitude, latitude, zoom, pitch, bearing } as MapViewState;
}

type Feature = { properties?: { id?: number } | null };

export function DenseBuildings() {
  const paneRefs = {
    stock: useRef<HTMLDivElement>(null),
    fp64: useRef<HTMLDivElement>(null),
    nofp64: useRef<HTMLDivElement>(null)
  };
  const cursorRef = useRef<LoupeCursor>(null);

  const persisted = useMemo(loadPersisted, []);
  const saved = persisted.controls ?? {};
  const init = <T,>(key: string, fallback: T): T => (key in saved ? (saved[key] as T) : fallback);

  const [viewState, setViewState] = useState<MapViewState>(persisted.viewState ?? INITIAL_VIEW_STATE);

  const [controls] = useControls(() => ({
    pattern: { value: init('pattern', 'diag-right-small'), options: PATTERN_KEYS as unknown as string[] },
    sizing: { value: init('sizing', 'world'), options: { 'World anchored': 'world', 'Follow zoom': 'screen' } },
    // 100% is the 64 m design repeat — far too coarse to stress anything on a 10 m building,
    // so this demo starts dense.
    patternSize: { value: init('patternSize', 10), min: 0.1, max: 500, step: 0.1, label: 'pattern size %' },
    screenPx: { value: init('screenPx', 24), min: 4, max: 200, step: 1, render: (get) => get('sizing') === 'screen' },
    lodMaxClamp: { value: init('lodMaxClamp', 0), min: 0, max: 8, step: 1, label: 'lodMaxClamp (mips)' },
    resolution: { value: init('resolution', 128), options: { '64px': 64, '128px': 128, '256px': 256 }, label: 'render resolution' },
    assetSource: {
      value: init('assetSource', 'png'),
      options: { png: 'png', 'svg (reverse-eng)': 'svg', 'svg (figma)': 'svg-figma', procedural: 'procedural' }
    },
    colorBy: { value: init('colorBy', 'id'), options: { 'per building': 'id', 'single color': 'single' } },
    basemap: {
      value: init('basemap', 'none'),
      options: { none: 'none', Positron: 'positron', 'Dark Matter': 'dark-matter', Voyager: 'voyager' }
    }
  }));
  const { pattern, sizing, patternSize, screenPx, lodMaxClamp, resolution, assetSource, colorBy, basemap } =
    controls;

  useEffect(() => {
    try {
      localStorage.setItem(STORE_KEY, JSON.stringify({ controls, viewState: sanitizeViewState(viewState) }));
    } catch {
      // storage may be blocked (private mode / sandbox) — persistence is best-effort.
    }
  }, [controls, viewState]);

  const [build, setBuild] = useState<AtlasBuild | null>(null);
  useEffect(() => {
    setBuild(buildAtlas({ resolution, mipLevels: 4, assetSource: assetSource as PatternAssetSource }));
  }, [resolution, assetSource]);

  const extensions = useMemo(
    () => ({
      stock: new FillStyleExtension({ pattern: true }),
      fp64: new CartoFillStyleExtension({ pattern: true, fp64: true }),
      nofp64: new NoFp64FillStyleExtension({ pattern: true })
    }),
    []
  );

  const zoom = viewState.zoom ?? INITIAL_VIEW_STATE.zoom!;
  // On-screen size is anchored to the 64px design unit and independent of render resolution:
  // the SOURCE_TILE_SIZE/resolution factor cancels the shader's x frame.width (= resolution).
  const texels = build?.cell ?? resolution;
  const onScreenBase =
    sizing === 'world' ? 1 : screenPx / (FILL_UV_SCALE * SOURCE_TILE_SIZE * Math.pow(2, Math.round(zoom)));
  const patternScale = (patternSize / 100) * onScreenBase * (SOURCE_TILE_SIZE / texels);
  // What one pattern repeat measures on screen right now — the number that says whether the
  // phase error below is a hairline or a whole cell.
  const cellCommon = FILL_UV_SCALE * texels * patternScale;
  const cellScreenPx = cellCommon * Math.pow(2, zoom);
  const errors = phaseErrors({
    longitude: viewState.longitude,
    latitude: viewState.latitude,
    zoom,
    cellCommon
  });

  const getFillColor = (f: Feature): [number, number, number, number] => {
    if (colorBy === 'single') return [25, 101, 176, 255];
    const [r, g, b] = COLOR_PALETTE[(f.properties?.id ?? 0) % COLOR_PALETTE.length];
    return [r, g, b, 255];
  };

  const layersFor = (extension: LayerExtension): Layer[] =>
    build
      ? [
          new GeoJsonLayer({
            // Shader-affecting controls go in the id so the layer (and its program) rebuilds.
            id: `buildings-${resolution}-${assetSource}-${lodMaxClamp}`,
            data: buildings,
            stroked: false,
            filled: true,
            getFillColor,
            fillPatternEnabled: true,
            fillPatternAtlas: build.atlas,
            fillPatternMapping: build.mapping,
            fillPatternMask: true,
            getFillPattern: () => pattern,
            getFillPatternScale: patternScale,
            textureParameters: { lodMaxClamp },
            extensions: [extension],
            updateTriggers: {
              getFillPattern: pattern,
              getFillPatternScale: patternScale,
              getFillColor: colorBy
            }
          })
        ]
      : [];

  const loupePanes: LoupePane[] = VARIANTS.map((v) => ({ key: v.key, label: v.label, ref: paneRefs[v.key] }));

  return (
    <div style={{ position: 'absolute', inset: 0, display: 'flex', flexDirection: 'column', background: '#0b0f14' }}>
      <div style={{ flex: 1, display: 'flex', gap: 1, background: '#334155', minHeight: 0 }}>
        {VARIANTS.map((variant) => (
          <div
            key={variant.key}
            ref={paneRefs[variant.key]}
            onMouseMove={(e) => {
              const rect = e.currentTarget.getBoundingClientRect();
              cursorRef.current = { paneKey: variant.key, x: e.clientX - rect.left, y: e.clientY - rect.top };
            }}
            style={{ position: 'relative', flex: 1, minWidth: 0, background: '#151b23' }}
          >
            <DeckGL
              viewState={viewState}
              onViewStateChange={({ viewState: vs }) => setViewState(vs as MapViewState)}
              controller={true}
              layers={layersFor(extensions[variant.key])}
            >
              {basemap !== 'none' && <Map mapStyle={CARTO_STYLES[basemap]} />}
            </DeckGL>
            <div
              style={{
                position: 'absolute',
                left: 8,
                bottom: 8,
                padding: '3px 7px',
                borderRadius: 4,
                font: '12px ui-monospace, monospace',
                color: '#e2e8f0',
                background: 'rgba(0,0,0,0.6)',
                pointerEvents: 'none'
              }}
            >
              {variant.label} · phase err {formatPx(errors[variant.key])}
            </div>
          </div>
        ))}
      </div>

      <div
        style={{
          padding: '6px 10px',
          font: '12px ui-monospace, monospace',
          color: '#cbd5e1',
          borderTop: '1px solid #334155'
        }}
      >
        zoom {zoom.toFixed(2)} · {sizing === 'world' ? 'world-anchored' : 'follow-zoom'} · repeat{' '}
        {cellScreenPx.toFixed(1)} px · {lodMaxClamp === 0 ? 'mips off' : `mips≤${lodMaxClamp}`} · drag any pane —
        all three share one camera
      </div>

      <MultiLoupe panes={loupePanes} cursorRef={cursorRef} />
    </div>
  );
}

// Phase error is meaningful across ~10 orders of magnitude — fixed decimals would print the
// two working variants as a flat "0.00".
function formatPx(px: number): string {
  if (px < 1e-4) return `${px.toExponential(0)} px`;
  return `${px.toFixed(px < 1 ? 3 : 2)} px`;
}

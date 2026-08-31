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
import { SeamFixFillStyleExtension } from './SeamFixFillStyleExtension';
import { MultiLoupe, type LoupeCursor, type LoupePane } from '../highzoom-fp32/MultiLoupe';

// Natural Earth countries — big polygons at low zoom, the opposite regime from dense-buildings.
// Low zoom keeps the pattern origin small, so fp32 phase precision is a non-issue and the only
// artifact left is the seam. GeoJsonLayer auto-loads the URL.
const COUNTRIES = 'https://d2ad6b4ur7yvpq.cloudfront.net/naturalearth-3.3.0/ne_50m_admin_0_scale_rank.geojson';

const INITIAL_VIEW_STATE: MapViewState = { longitude: 10, latitude: 30, zoom: 2 };

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
  { key: 'stock', label: '1. stock deck.gl (seams)' },
  { key: 'seam', label: '2. seam fix (textureGrad LOD)' }
] as const;
type VariantKey = (typeof VARIANTS)[number]['key'];

const STORE_KEY = 'deckgl-playground:seam-fix';
type Persisted = { controls?: Record<string, unknown>; viewState?: MapViewState };

function loadPersisted(): Persisted {
  try {
    const parsed = JSON.parse(localStorage.getItem(STORE_KEY) ?? '{}');
    return { ...parsed, viewState: sanitizeViewState(parsed.viewState) };
  } catch {
    return {};
  }
}

function sanitizeViewState(vs: unknown): MapViewState | undefined {
  if (!vs || typeof vs !== 'object') return undefined;
  const { longitude, latitude, zoom, pitch, bearing } = vs as Record<string, unknown>;
  if (![longitude, latitude, zoom].every((n) => typeof n === 'number' && Number.isFinite(n))) return undefined;
  return { longitude, latitude, zoom, pitch, bearing } as MapViewState;
}

type Feature = object;

export function SeamFix() {
  const paneRefs = {
    stock: useRef<HTMLDivElement>(null),
    seam: useRef<HTMLDivElement>(null)
  };
  const cursorRef = useRef<LoupeCursor>(null);

  const persisted = useMemo(loadPersisted, []);
  const saved = persisted.controls ?? {};
  const init = <T,>(key: string, fallback: T): T => (key in saved ? (saved[key] as T) : fallback);

  const [viewState, setViewState] = useState<MapViewState>(persisted.viewState ?? INITIAL_VIEW_STATE);

  const [controls] = useControls(() => ({
    pattern: { value: init('pattern', 'diag-right-small'), options: PATTERN_KEYS as unknown as string[] },
    // Follow-zoom by default: at world zoom a 64 m world-anchored repeat is sub-pixel, so the
    // pattern has to be pinned to a screen size to repeat visibly across a country.
    sizing: { value: init('sizing', 'screen'), options: { 'Follow zoom': 'screen', 'World anchored': 'world' } },
    patternSize: { value: init('patternSize', 100), min: 0.1, max: 500, step: 0.1, label: 'pattern size %' },
    screenPx: { value: init('screenPx', 40), min: 4, max: 200, step: 1, render: (get) => get('sizing') === 'screen' },
    // Seams are a mipmap artifact — with mips off (0) both panes look identical. Default high
    // so the stock pane shows the dark tile-boundary lines the fix removes.
    lodMaxClamp: { value: init('lodMaxClamp', 4), min: 0, max: 8, step: 1, label: 'lodMaxClamp (mips)' },
    resolution: { value: init('resolution', 128), options: { '64px': 64, '128px': 128, '256px': 256 }, label: 'render resolution' },
    assetSource: {
      value: init('assetSource', 'png'),
      options: { png: 'png', 'svg (reverse-eng)': 'svg', 'svg (figma)': 'svg-figma', procedural: 'procedural' }
    },
    colorBy: { value: init('colorBy', 'id'), options: { 'per country': 'id', 'single color': 'single' } },
    basemap: {
      value: init('basemap', 'none'),
      options: { none: 'none', Positron: 'positron', 'Dark Matter': 'dark-matter', Voyager: 'voyager' }
    }
  }));
  const { pattern, sizing, patternSize, screenPx, lodMaxClamp, resolution, assetSource, colorBy, basemap } = controls;

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
      seam: new SeamFixFillStyleExtension({ pattern: true })
    }),
    []
  );

  const zoom = viewState.zoom ?? INITIAL_VIEW_STATE.zoom!;
  const texels = build?.cell ?? resolution;
  const onScreenBase =
    sizing === 'world' ? 1 : screenPx / (FILL_UV_SCALE * SOURCE_TILE_SIZE * Math.pow(2, Math.round(zoom)));
  const patternScale = (patternSize / 100) * onScreenBase * (SOURCE_TILE_SIZE / texels);
  const cellCommon = FILL_UV_SCALE * texels * patternScale;
  const cellScreenPx = cellCommon * Math.pow(2, zoom);

  const getFillColor = (_f: Feature, info: { index: number }): [number, number, number, number] => {
    if (colorBy === 'single') return [25, 101, 176, 255];
    const [r, g, b] = COLOR_PALETTE[info.index % COLOR_PALETTE.length];
    return [r, g, b, 255];
  };

  const layersFor = (extension: LayerExtension): Layer[] =>
    build
      ? [
          new GeoJsonLayer({
            id: `countries-${resolution}-${assetSource}-${lodMaxClamp}`,
            data: COUNTRIES,
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
              layers={layersFor(extensions[variant.key as VariantKey])}
            >
              {/* preserveDrawingBuffer so the loupe can read the basemap canvas when idle. */}
              {basemap !== 'none' && <Map mapStyle={CARTO_STYLES[basemap]} preserveDrawingBuffer />}
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
              {variant.label}
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
        {cellScreenPx.toFixed(1)} px · {lodMaxClamp === 0 ? 'mips off — panes match' : `mips≤${lodMaxClamp}`} · drag
        either pane — both share one camera
      </div>

      <MultiLoupe panes={loupePanes} cursorRef={cursorRef} />
    </div>
  );
}

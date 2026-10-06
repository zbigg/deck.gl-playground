import { useEffect, useMemo, useState } from 'react';
import DeckGL from '@deck.gl/react';
import { _GlobeView as GlobeView, MapView } from '@deck.gl/core';
import type { Layer, View } from '@deck.gl/core';
import { VectorTileLayer } from '@deck.gl/carto';
import { vectorTableSource } from '@carto/api-client';
import { useControls } from 'leva';
import { PatchedVectorTileLayer } from './PatchedVectorTileLayer';
import { GlobeAwareVectorTileLayer } from './GlobeAwareVectorTileLayer';

// Public demo token from CartoDB/deck.gl-examples — read-only access to carto-demo-data only.
const ACCESS_TOKEN =
  'eyJhbGciOiJIUzI1NiJ9.eyJhIjoiYWNfbHFlM3p3Z3UiLCJqdGkiOiJkOTU4OWMyZiJ9.78MdzU2J6y-J6Far71_Mh7IQO9eYIZD9nECUiZJAVL4';
const API_BASE_URL = 'https://gcp-us-east1.api.carto.com';
const CONNECTION_NAME = 'carto_dw';

const DATASETS = {
  counties: 'carto-demo-data.demo_tables.usa_counties',
  states: 'carto-demo-data.demo_tables.usa_states_boundaries'
} as const;
type DatasetKey = keyof typeof DATASETS;

type ViewState = { longitude: number; latitude: number; zoom: number; pitch?: number; bearing?: number };
// Colorado — the area Cotality reported (sc-579024).
const INITIAL_VIEW_STATE: ViewState = { longitude: -105, latitude: 39.5, zoom: 4 };

const STORE_KEY = 'deckgl-playground:vector-tile-globe-clip';
type Persisted = { controls?: Record<string, unknown>; viewState?: ViewState };

function loadPersisted(): Persisted {
  try {
    const parsed = JSON.parse(localStorage.getItem(STORE_KEY) ?? '{}');
    return { ...parsed, viewState: sanitizeViewState(parsed.viewState) };
  } catch {
    return {};
  }
}

function sanitizeViewState(vs: unknown): ViewState | undefined {
  if (!vs || typeof vs !== 'object') return undefined;
  const { longitude, latitude, zoom, pitch, bearing } = vs as Record<string, unknown>;
  if (![longitude, latitude, zoom].every((n) => typeof n === 'number' && Number.isFinite(n))) return undefined;
  return { longitude, latitude, zoom, pitch, bearing } as ViewState;
}

const VARIANTS = [
  { key: 'stock', label: '1. stock VectorTileLayer' },
  { key: 'patched', label: '2. method 1 — no clip on globe' },
  { key: 'globeclip', label: '3. method 2 — globe-aware clip' }
] as const;
type VariantKey = (typeof VARIANTS)[number]['key'];

const LAYER_CLASS = {
  stock: VectorTileLayer,
  patched: PatchedVectorTileLayer,
  globeclip: GlobeAwareVectorTileLayer
} as const;

export function VectorTileGlobeClip() {
  const persisted = useMemo(loadPersisted, []);
  const saved = persisted.controls ?? {};
  const init = <T,>(key: string, fallback: T): T => (key in saved ? (saved[key] as T) : fallback);
  const fromUrl = new URLSearchParams(window.location.search);

  const [viewState, setViewState] = useState<ViewState>(persisted.viewState ?? INITIAL_VIEW_STATE);

  const [controls] = useControls(() => ({
    projection: {
      value: (fromUrl.get('projection') as string) || init('projection', 'globe'),
      options: { globe: 'globe', mercator: 'mercator' }
    },
    dataset: {
      value: (fromUrl.get('data') as string) || init('dataset', 'counties'),
      options: { 'US counties': 'counties', 'US states': 'states' }
    },
    // ClipExtension exists to stop translucent fills/lines from double-drawing where a tile's
    // buffered geometry overlaps its neighbour. Opaque hides that overdraw; translucent exposes
    // it — so the patched pane shows the real cost of dropping the clip, not just the fix.
    fill: {
      value: (fromUrl.get('fill') as string) || init('fill', 'translucent'),
      options: { translucent: 'translucent', opaque: 'opaque' }
    }
  }));
  const projection = controls.projection as 'globe' | 'mercator';
  const dataset = controls.dataset as DatasetKey;
  const fill = controls.fill as 'translucent' | 'opaque';

  useEffect(() => {
    try {
      localStorage.setItem(STORE_KEY, JSON.stringify({ controls, viewState: sanitizeViewState(viewState) }));
    } catch {
      // storage may be blocked (private mode / sandbox) — persistence is best-effort.
    }
  }, [controls, viewState]);

  const source = useMemo(
    () =>
      vectorTableSource({
        accessToken: ACCESS_TOKEN,
        apiBaseUrl: API_BASE_URL,
        connectionName: CONNECTION_NAME,
        tableName: DATASETS[dataset]
      }),
    [dataset]
  );

  const fillAlpha = fill === 'opaque' ? 255 : 90;
  const layerFor = (variant: VariantKey): Layer => {
    const LayerClass = LAYER_CLASS[variant];
    return new LayerClass({
      id: `${variant}-${dataset}-${fill}`,
      data: source,
      stroked: true,
      filled: true,
      getFillColor: [25, 101, 176, fillAlpha],
      getLineColor: [255, 255, 255, 200],
      lineWidthMinPixels: 0.75,
      pickable: false
    });
  };

  const view: View = projection === 'globe' ? new GlobeView({}) : new MapView({ repeat: true });
  const zoom = viewState.zoom ?? INITIAL_VIEW_STATE.zoom;

  return (
    <div style={{ position: 'absolute', inset: 0, display: 'flex', flexDirection: 'column', background: '#0b0f14' }}>
      <div style={{ flex: 1, display: 'flex', gap: 1, background: '#334155', minHeight: 0 }}>
        {VARIANTS.map((variant) => (
          <div key={variant.key} style={{ position: 'relative', flex: 1, minWidth: 0, background: '#05080c' }}>
            <DeckGL
              views={view}
              viewState={viewState as never}
              onViewStateChange={({ viewState: vs }) => setViewState(vs as unknown as ViewState)}
              controller={true}
              layers={[layerFor(variant.key)]}
            />
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
        {projection} · zoom {zoom.toFixed(2)} · {fill} · {DATASETS[dataset]} ·{' '}
        {projection === 'mercator'
          ? 'mercator — all three panes identical and complete; the bug is globe-only'
          : fill === 'translucent'
            ? 'globe: ①blank bands (clip misfires) · ②fills but tile-edge overdraw (clip dropped) · ③fills AND no overdraw (clip done in lng/lat)'
            : 'globe: ①blank bands · ②fills (overdraw hidden by opaque) · ③fills, clip kept — switch to translucent to see ② vs ③'}
      </div>
    </div>
  );
}

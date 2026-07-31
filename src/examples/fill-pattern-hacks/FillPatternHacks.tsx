import { type CSSProperties, useEffect, useMemo, useRef, useState } from 'react';
import { GeoJsonLayer } from '@deck.gl/layers';
import type { Layer, MapViewState } from '@deck.gl/core';
import { useControls } from 'leva';
import {
  buildAtlas,
  FILL_UV_SCALE,
  PATTERN_KEYS,
  SOURCE_TILE_SIZE,
  type AtlasBuild,
  type PatternAssetSource
} from './pattern-atlas';
import { CartoFillStyleExtension } from './CartoFillStyleExtension';
import { Loupe } from './Loupe';
import { AtlasPreview } from './AtlasPreview';
import { DeckGLRenderer, MapboxOverlayRenderer } from './renderers';

// Natural Earth countries (the dataset deck's own FillStyleExtension example uses).
const COUNTRIES = 'https://d2ad6b4ur7yvpq.cloudfront.net/naturalearth-3.3.0/ne_50m_admin_0_scale_rank.geojson';

// CARTO basemap styles.
const CARTO_STYLES: Record<string, string> = {
  positron: 'https://basemaps.cartocdn.com/gl/positron-gl-style/style.json',
  'dark-matter': 'https://basemaps.cartocdn.com/gl/dark-matter-gl-style/style.json',
  voyager: 'https://basemaps.cartocdn.com/gl/voyager-gl-style/style.json'
};

// First label layer per style (Builder hardcodes this the same way): in interleaved
// MapboxOverlay mode, deck layers with beforeId render under the basemap labels.
const CARTO_STYLE_FIRST_LABEL_LAYER: Record<string, string> = {
  positron: 'watername_ocean',
  'dark-matter': 'watername_ocean',
  voyager: 'watername_ocean'
};

// pitch/bearing must be present: MapboxOverlay drives maplibre as a controlled map, and undefined
// camera props wedge it on first load (before any viewState has been persisted).
const INITIAL_VIEW_STATE: MapViewState = { longitude: -3.7, latitude: 40.4, zoom: 4, pitch: 0, bearing: 0 };

// Dark categorical palette — the pattern is a mask tinted by fillColor, and the default
// basemap is light, so keep the tints dark and saturated for contrast.
const COLOR_PALETTE: [number, number, number][] = [
  [136, 46, 114],
  [25, 101, 176],
  [123, 65, 20],
  [153, 0, 13],
  [74, 20, 134],
  [8, 64, 129],
  [0, 68, 27],
  [0, 88, 80],
  [39, 100, 25],
  [40, 40, 40],
  [103, 0, 31],
  [84, 39, 143],
  [127, 39, 4],
  [3, 78, 123],
  [83, 0, 40],
  [23, 64, 88]
];

type Feature = { properties?: Record<string, unknown> };
function fillColorFor(f: Feature): [number, number, number, number] {
  const props = f.properties ?? {};
  const name = String(props.sr_subunit ?? props.name ?? '?').trim().toUpperCase();
  const idx = name.charCodeAt(0) || 0;
  const n = COLOR_PALETTE.length;
  const [r, g, b] = COLOR_PALETTE[((idx % n) + n) % n];
  return [r, g, b, 255];
}

// Persist the leva controls + map view so nothing resets on reload / hot-reload.
const STORE_KEY = 'deckgl-playground:fill-pattern-hacks';
type Persisted = { controls?: Record<string, unknown>; viewState?: MapViewState };
function loadPersisted(): Persisted {
  try {
    const parsed = JSON.parse(localStorage.getItem(STORE_KEY) ?? '{}');
    return { ...parsed, viewState: sanitizeViewState(parsed.viewState) };
  } catch {
    return {};
  }
}

// Keep only the stable numeric view fields. Storing the raw viewState deck emits
// during interaction can round-trip a dead transitionInterpolator/transitionDuration
// (class instance → {}), which wedges the controller and breaks panning on reload.
function sanitizeViewState(vs: unknown): MapViewState | undefined {
  if (!vs || typeof vs !== 'object') return undefined;
  const { longitude, latitude, zoom, pitch, bearing } = vs as Record<string, unknown>;
  if (![longitude, latitude, zoom].every((n) => typeof n === 'number' && Number.isFinite(n))) return undefined;
  return { longitude, latitude, zoom, pitch, bearing } as MapViewState;
}

const PANEL_WIDTH = 360;

const LINK_STYLE: CSSProperties = {
  background: 'none',
  border: 'none',
  padding: 0,
  color: '#2563eb',
  textDecoration: 'underline',
  cursor: 'pointer',
  font: 'inherit'
};

export function FillPatternHacks() {
  const containerRef = useRef<HTMLDivElement>(null);
  const mouseRef = useRef<{ x: number; y: number } | null>(null);

  const persisted = useMemo(loadPersisted, []);
  const saved = persisted.controls ?? {};
  const init = <T,>(key: string, fallback: T): T => (key in saved ? (saved[key] as T) : fallback);

  const [viewState, setViewState] = useState<MapViewState>(persisted.viewState ?? INITIAL_VIEW_STATE);

  const [controls, setControls] = useControls(() => ({
    renderer: { value: init('renderer', 'overlay'), options: { DeckGL: 'deckgl', MapboxOverlay: 'overlay' } },
    basemap: {
      value: init('basemap', 'positron'),
      options: { Positron: 'positron', 'Dark Matter': 'dark-matter', Voyager: 'voyager' }
    },
    pattern: { value: init('pattern', 'diag-right-medium'), options: PATTERN_KEYS as unknown as string[] },
    sizing: { value: init('sizing', 'screen'), options: { 'World anchored': 'world', 'Follow zoom': 'screen' } },
    // Builder's fillPatternSize: a percent (100% = ×1, so ×0.001–×5) on the auto-computed scale.
    patternSize: { value: init('patternSize', 100), min: 0.1, max: 500, step: 0.1, label: 'pattern size %' },
    screenPx: {
      value: init('screenPx', 64),
      min: 4,
      max: 200,
      step: 1,
      render: (get) => get('sizing') === 'screen' && get('assetSource') !== 'png'
    },
    // png displays at its native 64px in follow-zoom (locked).
    screenPxPng: {
      value: 64,
      disabled: true,
      label: 'screenPx',
      render: (get) => get('sizing') === 'screen' && get('assetSource') === 'png'
    },
    lodMaxClamp: { value: init('lodMaxClamp', 0), min: 0, max: 8, step: 1, label: 'lodMaxClamp (mips)' },
    mipLevels: { value: init('mipLevels', 4), min: 1, max: 6, step: 1, label: 'margin mip levels' },
    renderResolution: {
      value: init('renderResolution', 128),
      options: { '64px (1×)': 64, '128px (2×)': 128, '256px (4×)': 256 },
      label: 'render res (texels)',
      render: (get) => get('assetSource') !== 'png'
    },
    // png is a fixed 64px export — higher texel res would only upscale, so lock it.
    renderResolutionPng: {
      value: 64,
      options: { '64px (1×)': 64 },
      label: 'render res (texels)',
      disabled: true,
      render: (get) => get('assetSource') === 'png'
    },
    assetSource: {
      value: init('assetSource', 'svg-figma'),
      options: { png: 'png', 'svg (reverse-eng)': 'svg', 'svg (figma)': 'svg-figma', procedural: 'procedural' }
    },
    seamFix: { value: init('seamFix', true), label: 'seam fix (#7326)' },
    fp64: { value: init('fp64', true), label: 'fp64 origin' },
    showLoupe: { value: init('showLoupe', true), label: 'loupe' },
    showAtlas: { value: init('showAtlas', true), label: 'atlas preview' },
    showInfo: { value: init('showInfo', true), label: 'findings panel' }
  }));
  const {
    renderer,
    pattern,
    sizing,
    patternSize,
    screenPx = 64,
    lodMaxClamp,
    mipLevels,
    renderResolution,
    assetSource,
    seamFix,
    fp64,
    basemap,
    showLoupe,
    showAtlas,
    showInfo
  } = controls;

  // png is a fixed 64px export: force both its render resolution and follow-zoom size to 64
  // (the editable knobs are hidden and shown disabled at 64 for png).
  const effectiveResolution = assetSource === 'png' ? 64 : renderResolution;
  const effectiveScreenPx = assetSource === 'png' ? 64 : screenPx;

  useEffect(() => {
    try {
      localStorage.setItem(STORE_KEY, JSON.stringify({ controls, viewState: sanitizeViewState(viewState) }));
    } catch {
      // storage may be blocked (private mode / sandbox) — persistence is best-effort.
    }
  }, [controls, viewState]);

  // Rebuild the atlas only when the atlas-shaping controls change.
  const [build, setBuild] = useState<AtlasBuild | null>(null);
  useEffect(() => {
    setBuild(buildAtlas({ resolution: effectiveResolution, mipLevels, assetSource: assetSource as PatternAssetSource }));
  }, [effectiveResolution, mipLevels, assetSource]);

  // Resolve the assembled atlas image for the preview (deck consumes the same promise separately).
  const [atlasImage, setAtlasImage] = useState<CanvasImageSource | null>(null);
  useEffect(() => {
    let cancelled = false;
    setAtlasImage(null);
    build?.atlas.then((img) => !cancelled && setAtlasImage(img)).catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [build]);

  const extension = useMemo(() => new CartoFillStyleExtension({ pattern: true, seamFix, fp64 }), [seamFix, fp64]);

  const zoom = viewState.zoom ?? INITIAL_VIEW_STATE.zoom!;
  const discreteZoom = Math.round(zoom); // discrete zoom actually used for the atlas / scale math
  const resolution = build?.cell ?? effectiveResolution; // atlas texels per tile
  // On-screen size is anchored to the 64px design unit and is independent of render resolution:
  // the (SOURCE_TILE_SIZE / resolution) factor cancels the shader's ×frame.width (= resolution),
  // so bumping resolution only sharpens. World = fixed geographic; follow-zoom = ~screenPx CSS.
  const onScreenBase =
    sizing === 'world' ? 1 : effectiveScreenPx / (FILL_UV_SCALE * SOURCE_TILE_SIZE * Math.pow(2, discreteZoom));
  const patternScale = (patternSize / 100) * onScreenBase * (SOURCE_TILE_SIZE / resolution);

  const layers = build
    ? [
        new GeoJsonLayer({
          // Shader-affecting controls go in the id so the layer (and its program) rebuilds.
          id: `countries-${effectiveResolution}-${mipLevels}-${assetSource}-${seamFix}-${fp64}-${lodMaxClamp}`,
          data: COUNTRIES,
          stroked: true,
          filled: true,
          // Only meaningful when interleaved; deck's own canvas always sits on top in classic mode.
          beforeId: renderer === 'overlay' ? CARTO_STYLE_FIRST_LABEL_LAYER[basemap] : undefined,
          getFillColor: fillColorFor,
          getLineColor: [20, 24, 28, 200],
          lineWidthMinPixels: 0.5,
          // Fill pattern (deck FillStyleExtension) — same descriptor shape api-client emits.
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
            getFillPatternScale: patternScale
          }
        })
      ]
    : [];

  const Renderer = renderer === 'overlay' ? MapboxOverlayRenderer : DeckGLRenderer;

  return (
    <div style={{ position: 'absolute', inset: 0 }}>
      <div
        ref={containerRef}
        onMouseMove={(e) => {
          const rect = e.currentTarget.getBoundingClientRect();
          mouseRef.current = { x: e.clientX - rect.left, y: e.clientY - rect.top };
        }}
        style={{ position: 'absolute', top: 0, bottom: 0, right: 0, left: showInfo ? PANEL_WIDTH : 0 }}
      >
        <Renderer
          viewState={viewState}
          onViewStateChange={setViewState}
          layers={layers as Layer[]}
          mapStyle={CARTO_STYLES[basemap]}
        />
        <div
          style={{
            position: 'absolute',
            left: 12,
            bottom: 12,
            padding: '4px 8px',
            borderRadius: 4,
            font: '12px ui-monospace, monospace',
            color: '#cbd5e1',
            background: 'rgba(0,0,0,0.5)'
          }}
        >
          zoom {zoom.toFixed(2)} → {discreteZoom} · {sizing === 'world' ? 'world-anchored' : 'follow-zoom'} ·{' '}
          {lodMaxClamp === 0 ? 'mips off' : `mips≤${lodMaxClamp}`}
          {seamFix ? ' · seam-fix' : ''}
          {fp64 ? ' · fp64' : ''}
        </div>
        {showAtlas && (
          <AtlasPreview image={atlasImage} onClose={() => setControls({ showAtlas: false })} style={{ right: 230, bottom: 12 }} />
        )}
        {showLoupe && (
          <Loupe
            containerRef={containerRef}
            mouseRef={mouseRef}
            onClose={() => setControls({ showLoupe: false })}
            style={{ right: 12, bottom: 12 }}
          />
        )}
      </div>
      {showInfo && (
        <div
          style={{
            position: 'absolute',
            top: 0,
            left: 0,
              height: '100%',
              width: PANEL_WIDTH,
              boxSizing: 'border-box',
              padding: '28px 26px',
              overflowY: 'auto',
              background: '#ffffff',
              color: '#0f172a',
              boxShadow: '10px 0 30px rgba(0,0,0,0.18)',
              font: '14px/1.55 system-ui, -apple-system, "Segoe UI", sans-serif',
              zIndex: 10
            }}
          >
            <button
              onClick={() => setControls({ showInfo: false })}
              aria-label="close findings panel"
              style={{
                position: 'absolute',
                top: 14,
                right: 16,
                border: 'none',
                background: 'transparent',
                fontSize: 20,
                lineHeight: 1,
                cursor: 'pointer',
                color: '#94a3b8'
              }}
            >
              ×
            </button>
            <div
              style={{
                fontSize: 12,
                fontWeight: 600,
                letterSpacing: '0.09em',
                textTransform: 'uppercase',
                color: '#6366f1'
              }}
            >
              Polygon fill patterns
            </div>
            <h2 style={{ margin: '6px 0 22px', fontSize: 23, fontWeight: 700 }}>Rendering — key findings</h2>

            <div style={{ marginBottom: 20, paddingLeft: 15, borderLeft: '3px solid #10b981' }}>
              <div style={{ fontWeight: 700, marginBottom: 5 }}>Crispness</div>
              <div style={{ color: '#334155' }}>
                Higher <b>render resolution</b> with <b>fewer mip levels</b> gives sharper, crisper patterns. SVG
                re-exported at <b>2× (128&nbsp;px)</b> beats the fixed 64&nbsp;px PNG on high-DPI screens.
              </div>
              <div style={{ marginTop: 10, fontSize: 13, color: '#334155' }}>
                Try it (svg):{' '}
                <button onClick={() => setControls({ renderResolution: 64 })} style={LINK_STYLE}>
                  1×
                </button>
                {'  ·  '}
                <button onClick={() => setControls({ renderResolution: 128 })} style={LINK_STYLE}>
                  2×
                </button>
                {'  ·  '}
                <button onClick={() => setControls({ renderResolution: 256 })} style={LINK_STYLE}>
                  4×
                </button>
              </div>
            </div>

            <div style={{ marginBottom: 20, paddingLeft: 15, borderLeft: '3px solid #f59e0b' }}>
              <div style={{ fontWeight: 700, marginBottom: 5 }}>Moiré / anti-aliasing</div>
              <div style={{ color: '#334155' }}>
                Raising <b>lodMaxClamp</b> (using more mip levels) noticeably <b>reduces</b> the shimmer / moiré when
                zoomed out — it doesn't fully remove it, and costs a little crispness. The <b>sharpness ↔ moiré</b>{' '}
                trade-off.
              </div>
              <div style={{ marginTop: 10, fontSize: 13, color: '#334155' }}>
                Try it:{' '}
                <button onClick={() => setControls({ lodMaxClamp: 0 })} style={LINK_STYLE}>
                  mips off (moiré)
                </button>
                {'  ·  '}
                <button onClick={() => setControls({ lodMaxClamp: 1 })} style={LINK_STYLE}>
                  mips ≤ 1 (reduced)
                </button>
              </div>
            </div>

            <div
              style={{
                marginTop: 26,
                padding: '11px 13px',
                borderRadius: 8,
                background: '#f1f5f9',
                font: '12px ui-monospace, monospace',
                color: '#475569'
              }}
            >
              now: {assetSource} · res {resolution}px · mips {lodMaxClamp === 0 ? 'off' : `≤${lodMaxClamp}`}
            </div>
          </div>
      )}
    </div>
  );
}

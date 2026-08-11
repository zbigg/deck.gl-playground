import { type CSSProperties, useEffect, useMemo, useRef, useState } from 'react';
import { GeoJsonLayer, SolidPolygonLayer, TextLayer } from '@deck.gl/layers';
import type { Layer, MapViewState } from '@deck.gl/core';
import { useControls } from 'leva';
import {
  buildAtlas,
  FILL_UV_SCALE,
  PATTERN_KEYS,
  patternSwatchUrl,
  SOURCE_TILE_SIZE,
  type AtlasBuild,
  type PatternAssetSource,
  type PatternKey
} from './pattern-atlas';
import { _buildPatternAtlas } from '@carto/api-client';
import {
  buildEncoding,
  PATTERN_COLUMN_LABELS,
  type Feature as EncFeature,
  type PatternColumn
} from './pattern-encoding';
import { CartoFillStyleExtension } from './CartoFillStyleExtension';
import { Loupe } from './Loupe';
import { AtlasPreview } from './AtlasPreview';
import { DeckGLRenderer, MapboxOverlayRenderer } from './renderers';

// Natural Earth countries (the dataset deck's own FillStyleExtension example uses).
const COUNTRIES = 'https://d2ad6b4ur7yvpq.cloudfront.net/naturalearth-3.3.0/ne_50m_admin_0_scale_rank.geojson';
// All 50 US states (served from /public). Carries per-state columns for data-driven patterns.
const USA_STATES = `${import.meta.env.BASE_URL}usa_states_boundaries.geojson`;

// Home view per dataset — framed on the data. usa-states frames the continental US (AK/HI
// sit off-frame, as on a typical national map) with the side panel open.
const DATASET_HOME: Record<string, MapViewState> = {
  countries: { longitude: -3.7, latitude: 40.4, zoom: 4, pitch: 0, bearing: 0 },
  'usa-states': { longitude: -96, latitude: 38.5, zoom: 3.5, pitch: 0, bearing: 0 },
  // Synthetic LOD×aniso grid: centered on (0,0), spanning ~2/3 of the world → whole-world zoom.
  matrix: { longitude: 0, latitude: 0, zoom: 1.2, pitch: 0, bearing: 0 }
};

// LOD×anisotropy comparison grid: synthetic quads centered on the origin, one per (lodMaxClamp,
// maxAnisotropy) combo. The grid spans ~2/3 of the world so the pattern is heavily minified (moiré
// regime) by default.
const LOD_VALUES = [0, 1, 2, 4, 8]; // rows: lodMaxClamp (mip levels the sampler may use)
const ANISO_VALUES = [1, 2, 4, 8, 16]; // cols: maxAnisotropy (taps along the compression axis)
const GRID_W = 240; // ~2/3 of 360° lon
const GRID_H = 113; // ~2/3 of the mercator-safe lat range (±~85°)

type MatrixCell = { lod: number; aniso: number; ring: [number, number][]; cx: number; cy: number };
function buildMatrix(): MatrixCell[] {
  const nCols = ANISO_VALUES.length;
  const nRows = LOD_VALUES.length;
  const gapFrac = 0.12;
  const cellW = GRID_W / (nCols + (nCols - 1) * gapFrac);
  const cellH = GRID_H / (nRows + (nRows - 1) * gapFrac);
  const startX = -GRID_W / 2;
  const startY = GRID_H / 2;
  const cells: MatrixCell[] = [];
  LOD_VALUES.forEach((lod, r) => {
    const yTop = startY - r * cellH * (1 + gapFrac);
    const yBot = yTop - cellH;
    ANISO_VALUES.forEach((aniso, c) => {
      const xLeft = startX + c * cellW * (1 + gapFrac);
      const xRight = xLeft + cellW;
      cells.push({
        lod,
        aniso,
        cx: (xLeft + xRight) / 2,
        cy: (yTop + yBot) / 2,
        ring: [
          [xLeft, yTop],
          [xRight, yTop],
          [xRight, yBot],
          [xLeft, yBot],
          [xLeft, yTop]
        ]
      });
    });
  });
  return cells;
}
const MATRIX = buildMatrix();

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

// Native DPR is live — it changes when the window moves to a monitor with a different scale.
function useNativeDevicePixelRatio(): number {
  const [dpr, setDpr] = useState(() => window.devicePixelRatio);
  useEffect(() => {
    const mq = window.matchMedia(`(resolution: ${dpr}dppx)`);
    const onChange = () => setDpr(window.devicePixelRatio);
    mq.addEventListener('change', onChange);
    return () => mq.removeEventListener('change', onChange);
  }, [dpr]);
  return dpr;
}

// The builtin builder plus whatever the shipped @carto/api-client alpha produces, so the two
// can be A/B'd against the same shader/scale path. The api-client build carries its own
// scaleAdjustment + sampler params, consumed verbatim (exactly as parse-map does).
type HarnessBuild = AtlasBuild & {
  scaleAdjustment?: number;
  textureParameters?: { lodMaxClamp: number; maxAnisotropy: number };
};

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

  // Only reuse the persisted view if it belongs to the dataset we're starting on; otherwise a
  // view saved over Europe (countries) would leave the states off-screen. Falls back to the
  // dataset's home frame.
  const startDataset = init('dataset', 'usa-states');
  const startView =
    persisted.viewState && saved.dataset === startDataset
      ? persisted.viewState
      : DATASET_HOME[startDataset] ?? INITIAL_VIEW_STATE;
  const [viewState, setViewState] = useState<MapViewState>(startView);

  const [controls, setControls] = useControls(() => ({
    renderer: { value: init('renderer', 'overlay'), options: { DeckGL: 'deckgl', MapboxOverlay: 'overlay' } },
    basemap: {
      value: init('basemap', 'positron'),
      options: { Positron: 'positron', 'Dark Matter': 'dark-matter', Voyager: 'voyager' }
    },
    // 3D: tilt to a grazing angle so pattern footprints elongate (where anisotropy actually
    // differs from mips), and unlock pitch/bearing drag. Off = locked flat top-down.
    view3d: { value: init('view3d', false), label: '3D (tilt)' },
    pitch3d: {
      value: init('pitch3d', 44),
      min: 0,
      max: 60,
      step: 1,
      label: 'pitch °',
      render: (get) => get('view3d')
    },
    dpr: {
      value: init('dpr', 'native'),
      options: { native: 'native', 'force 1×': 'one' },
      label: 'DPR',
      render: () => window.devicePixelRatio !== 1
    },
    dataset: {
      value: init('dataset', 'usa-states'),
      options: { 'USA states': 'usa-states', Countries: 'countries', 'LOD×aniso matrix': 'matrix' }
    },
    // Column driving getFillPattern. 'fixed' falls back to the single `pattern` below.
    // Numeric columns only exist on the USA-states dataset.
    patternColumn: {
      value: init('patternColumn', 'unemp_rate'),
      options: Object.fromEntries(
        (Object.entries(PATTERN_COLUMN_LABELS) as [PatternColumn, string][]).map(([k, label]) => [label, k])
      ),
      render: (get) => get('dataset') === 'usa-states',
      label: 'pattern by'
    },
    // Used when patternColumn is 'fixed' (or the countries dataset, which has no data columns).
    pattern: {
      value: init('pattern', 'diag-right-medium'),
      options: PATTERN_KEYS as unknown as string[],
      render: (get) => get('dataset') !== 'usa-states' || get('patternColumn') === 'fixed'
    },
    // Which code assembles the sprite sheet: the playground's own builder (POC), or the
    // _buildPatternAtlas shipped in the pinned @carto/api-client alpha — for verifying the
    // production atlas against the proven builtin one.
    atlasBuilder: {
      value: init('atlasBuilder', 'builtin'),
      options: { 'builtin (POC)': 'builtin', '@carto/api-client': 'api-client' },
      label: 'atlas builder'
    },
    sizing: { value: init('sizing', 'screen'), options: { 'World anchored': 'world', 'Follow zoom': 'screen' } },
    // Builder's fillPatternSize: a percent (100% = ×1, so ×0.001–×5) on the auto-computed scale.
    patternSize: { value: init('patternSize', 100), min: 0.1, max: 500, step: 0.1, label: 'pattern size %' },
    screenPx: {
      value: init('screenPx', 64),
      min: 4,
      max: 200,
      step: 1,
      render: (get) =>
        get('sizing') === 'screen' && (get('assetSource') !== 'png' || get('atlasBuilder') === 'api-client')
    },
    // png displays at its native 64px in follow-zoom (locked).
    screenPxPng: {
      value: 64,
      disabled: true,
      label: 'screenPx',
      render: (get) =>
        get('sizing') === 'screen' && get('assetSource') === 'png' && get('atlasBuilder') !== 'api-client'
    },
    // Hidden for the matrix dataset — there they become the two grid axes and vary per layer.
    lodMaxClamp: {
      value: init('lodMaxClamp', 2),
      min: 0,
      max: 8,
      step: 1,
      label: 'lodMaxClamp (mips)',
      render: (get) => get('dataset') !== 'matrix'
    },
    // Anisotropic filtering: N texture taps along the axis of compression. 1 = off. Needs mips
    // (raise lodMaxClamp) to bite. Kills minification moiré with far less crispness loss than mips alone.
    maxAnisotropy: {
      value: init('maxAnisotropy', 4),
      min: 1,
      max: 16,
      step: 1,
      label: 'maxAnisotropy',
      render: (get) => get('dataset') !== 'matrix'
    },
    mipLevels: { value: init('mipLevels', 4), min: 1, max: 6, step: 1, label: 'margin mip levels' },
    renderResolution: {
      value: init('renderResolution', 128),
      options: { '64px (1×)': 64, '128px (2×)': 128, '256px (4×)': 256 },
      label: 'render res (texels)',
      render: (get) => get('assetSource') !== 'png' || get('atlasBuilder') === 'api-client'
    },
    // png is a fixed 64px export — higher texel res would only upscale, so lock it.
    renderResolutionPng: {
      value: 64,
      options: { '64px (1×)': 64 },
      label: 'render res (texels)',
      disabled: true,
      render: (get) => get('assetSource') === 'png' && get('atlasBuilder') !== 'api-client'
    },
    // api-client bundles its own (svg) assets — the source knob only shapes the builtin builder.
    assetSource: {
      value: init('assetSource', 'svg-figma'),
      options: { png: 'png', 'svg (reverse-eng)': 'svg', 'svg (figma)': 'svg-figma', procedural: 'procedural' },
      render: (get) => get('atlasBuilder') !== 'api-client'
    },
    seamFix: { value: init('seamFix', true), label: 'seam fix (#7326)' },
    fp64: { value: init('fp64', true), label: 'fp64 origin' },
    showLoupe: { value: init('showLoupe', true), label: 'loupe' },
    showAtlas: { value: init('showAtlas', true), label: 'atlas preview' },
    showInfo: { value: init('showInfo', true), label: 'findings panel' }
  }));
  const {
    renderer,
    dpr = 'native',
    view3d,
    pitch3d = 44,
    dataset,
    patternColumn,
    pattern,
    atlasBuilder,
    sizing,
    patternSize,
    screenPx = 64,
    lodMaxClamp,
    maxAnisotropy,
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
  // (the editable knobs are hidden and shown disabled at 64 for png). The api-client builder
  // has no png path, so the lock only applies to the builtin builder.
  const usingApiClient = atlasBuilder === 'api-client';
  const effectiveResolution = !usingApiClient && assetSource === 'png' ? 64 : renderResolution;
  const effectiveScreenPx = !usingApiClient && assetSource === 'png' ? 64 : screenPx;

  useEffect(() => {
    try {
      localStorage.setItem(STORE_KEY, JSON.stringify({ controls, viewState: sanitizeViewState(viewState) }));
    } catch {
      // storage may be blocked (private mode / sandbox) — persistence is best-effort.
    }
  }, [controls, viewState]);

  // Rebuild the atlas only when the atlas-shaping controls change. The api-client path maps
  // the playground's texels-per-tile knob onto {size, resolution} (64 × N = renderResolution)
  // and adopts the build's own scaleAdjustment + sampler params.
  const [build, setBuild] = useState<HarnessBuild | null>(null);
  useEffect(() => {
    if (usingApiClient) {
      const { atlas, mapping, cell, scaleAdjustment, textureParameters } = _buildPatternAtlas({
        size: SOURCE_TILE_SIZE,
        resolution: effectiveResolution / SOURCE_TILE_SIZE,
        mipLevels
      });
      setBuild({ atlas, mapping, cell, scaleAdjustment, textureParameters });
    } else {
      setBuild(
        buildAtlas({ resolution: effectiveResolution, mipLevels, assetSource: assetSource as PatternAssetSource })
      );
    }
  }, [usingApiClient, effectiveResolution, mipLevels, assetSource]);

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

  // Load the states FeatureCollection once so we can derive class breaks + a legend from it
  // (and hand the same object to the layer instead of re-fetching by URL).
  const [statesData, setStatesData] = useState<GeoJSON.FeatureCollection | null>(null);
  useEffect(() => {
    if (dataset !== 'usa-states' || statesData) return;
    let cancelled = false;
    fetch(USA_STATES)
      .then((r) => r.json())
      .then((json) => !cancelled && setStatesData(json))
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [dataset, statesData]);

  // On an actual dataset switch, fly to that dataset's home view (skip the first mount so the
  // persisted view is kept).
  const prevDataset = useRef(dataset);
  useEffect(() => {
    if (prevDataset.current === dataset) return;
    prevDataset.current = dataset;
    if (DATASET_HOME[dataset]) setViewState(DATASET_HOME[dataset]);
  }, [dataset]);

  // Toggling 3D tilts to the configured pitch / snaps back flat; moving the pitch slider while
  // in 3D applies live. Map-drag pitch changes and persisted pitch are otherwise untouched (no
  // sync back into the slider), so reloads and mid-session drags aren't stomped.
  const prev3d = useRef(view3d);
  useEffect(() => {
    const toggled = prev3d.current !== view3d;
    prev3d.current = view3d;
    if (toggled) {
      setViewState((vs) => ({ ...vs, pitch: view3d ? pitch3d : 0, bearing: view3d ? vs.bearing ?? 0 : 0 }));
    } else if (view3d) {
      setViewState((vs) => ({ ...vs, pitch: pitch3d }));
    }
  }, [view3d, pitch3d]);

  const useMatrix = dataset === 'matrix';

  // Data-driven pattern encoding: column value → pattern key, plus legend entries.
  const useData = dataset === 'usa-states';
  const activeColumn = (useData ? patternColumn : 'fixed') as PatternColumn;
  const encoding = useMemo(
    () => buildEncoding(activeColumn, (statesData?.features ?? []) as EncFeature[], pattern as PatternKey),
    [activeColumn, statesData, pattern]
  );

  const extension = useMemo(() => new CartoFillStyleExtension({ pattern: true, seamFix, fp64 }), [seamFix, fp64]);

  const zoom = viewState.zoom ?? INITIAL_VIEW_STATE.zoom!;
  const discreteZoom = Math.round(zoom); // discrete zoom actually used for the atlas / scale math
  const resolution = build?.cell ?? effectiveResolution; // atlas texels per tile
  // On-screen size is anchored to the 64px design unit and is independent of render resolution:
  // the (SOURCE_TILE_SIZE / resolution) factor cancels the shader's ×frame.width (= resolution),
  // so bumping resolution only sharpens. World = fixed geographic; follow-zoom = ~screenPx CSS.
  const onScreenBase =
    sizing === 'world' ? 1 : effectiveScreenPx / (FILL_UV_SCALE * SOURCE_TILE_SIZE * Math.pow(2, discreteZoom));
  // api-client builds carry their own factor (consumed exactly as parse-map does); if it
  // disagrees with the builtin SOURCE_TILE_SIZE/resolution, that difference IS the finding.
  const densityFactor = build?.scaleAdjustment ?? SOURCE_TILE_SIZE / resolution;
  const patternScale = (patternSize / 100) * onScreenBase * densityFactor;
  // Sampler params actually applied to the data layers (api-client builds bring their own).
  const effLod = build?.textureParameters?.lodMaxClamp ?? lodMaxClamp;
  const effAniso = build?.textureParameters?.maxAnisotropy ?? maxAnisotropy;

  const beforeId = renderer === 'overlay' ? CARTO_STYLE_FIRST_LABEL_LAYER[basemap] : undefined;
  const patternProps = build && {
    fillPatternEnabled: true,
    fillPatternAtlas: build.atlas,
    fillPatternMapping: build.mapping,
    fillPatternMask: true,
    getFillPatternScale: patternScale,
    extensions: [extension]
  };

  const dataLayers =
    build && patternProps
      ? [
          new GeoJsonLayer({
            // Shader-affecting controls go in the id so the layer (and its program) rebuilds.
            id: `fill-${atlasBuilder}-${effectiveResolution}-${mipLevels}-${assetSource}-${seamFix}-${fp64}-${lodMaxClamp}-${maxAnisotropy}`,
            data: useData ? statesData ?? USA_STATES : COUNTRIES,
            stroked: true,
            filled: true,
            // Only meaningful when interleaved; deck's own canvas always sits on top in classic mode.
            beforeId,
            getFillColor: fillColorFor,
            getLineColor: [20, 24, 28, 200],
            lineWidthMinPixels: 0.5,
            // Fill pattern (deck FillStyleExtension) — same descriptor shape api-client emits.
            ...patternProps,
            getFillPattern: encoding.getPattern,
            // api-client builds ship sampler params sized to their own atlas; use them verbatim.
            textureParameters: build?.textureParameters ?? { lodMaxClamp, maxAnisotropy },
            updateTriggers: { getFillPattern: encoding, getFillPatternScale: patternScale }
          })
        ]
      : [];

  // Matrix: one pattern layer per (lod, aniso) cell — identical FSE settings except the sampler.
  const matrixLayers =
    build && patternProps
      ? [
          new SolidPolygonLayer<MatrixCell>({
            id: 'matrix-bg',
            data: MATRIX,
            getPolygon: (d) => [d.ring],
            getFillColor: [255, 255, 255, 90],
            // @ts-expect-error beforeId is a valid interleaved-MapboxOverlay prop, absent from primitive-layer types
            beforeId
          }),
          ...MATRIX.map(
            (cell) =>
              new GeoJsonLayer({
                id: `cell-${cell.lod}-${cell.aniso}-${atlasBuilder}-${effectiveResolution}-${mipLevels}-${assetSource}-${seamFix}-${fp64}`,
                data: {
                  type: 'FeatureCollection',
                  features: [{ type: 'Feature', properties: {}, geometry: { type: 'Polygon', coordinates: [cell.ring] } }]
                } as GeoJSON.FeatureCollection,
                stroked: true,
                filled: true,
                beforeId,
                getFillColor: [30, 30, 30, 255],
                getLineColor: [15, 23, 42, 180],
                lineWidthMinPixels: 1,
                ...patternProps,
                getFillPattern: () => pattern,
                textureParameters: { lodMaxClamp: cell.lod, maxAnisotropy: cell.aniso },
                updateTriggers: { getFillPattern: pattern, getFillPatternScale: patternScale }
              })
          ),
          new TextLayer<MatrixCell>({
            id: 'matrix-labels',
            data: MATRIX,
            getPosition: (d) => [d.cx, d.cy],
            getText: (d) => `lod ${d.lod} · aniso ${d.aniso}×`,
            getSize: 13,
            sizeUnits: 'pixels',
            getColor: [15, 23, 42, 255],
            background: true,
            getBackgroundColor: [255, 255, 255, 215],
            backgroundPadding: [5, 3],
            fontFamily: 'ui-monospace, monospace',
            billboard: true,
            // Draw on top in 3D: without this the labels depth-fight / sink into the tilted quads.
            parameters: { depthCompare: 'always', depthWriteEnabled: false }
          })
        ]
      : [];

  const layers = useMatrix ? matrixLayers : dataLayers;

  const nativeDpr = useNativeDevicePixelRatio();
  const forcedPixelRatio = dpr === 'one' && nativeDpr !== 1 ? 1 : undefined;

  const Renderer = renderer === 'overlay' ? MapboxOverlayRenderer : DeckGLRenderer;

  const handleTilt = () => setControls({ view3d: true });
  const handleFlat = () => setControls({ view3d: false });

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
          // Interleaved (overlay) mode can only take a DPR change at maplibre construction, so
          // remount it when the forced ratio changes; classic mode updates in place (stable key).
          key={renderer === 'overlay' ? `overlay-${forcedPixelRatio ?? 'native'}` : 'deckgl'}
          viewState={viewState}
          onViewStateChange={setViewState}
          layers={layers as Layer[]}
          mapStyle={CARTO_STYLES[basemap]}
          pixelRatio={forcedPixelRatio}
          rotate={view3d}
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
          dpr {forcedPixelRatio ? `${nativeDpr} → 1 (forced)` : nativeDpr} · zoom {zoom.toFixed(2)} → {discreteZoom} ·{' '}
          {sizing === 'world' ? 'world-anchored' : 'follow-zoom'} ·{' '}
          {effLod === 0 ? 'mips off' : `mips≤${effLod}`}
          {effAniso > 1 ? ` · aniso ${effAniso}×` : ''}
          {usingApiClient ? ' · atlas: api-client' : ''}
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

            <div style={{ marginBottom: 20, paddingLeft: 15, borderLeft: '3px solid #0ea5e9' }}>
              <div style={{ fontWeight: 700, marginBottom: 5 }}>Anisotropic filtering</div>
              <div style={{ color: '#334155' }}>
                Pattern moiré is texture minification aliasing in the fill <i>interior</i>. <b>Anisotropy</b> takes
                several texture taps along the axis the pattern is compressed on, killing the shimmer with <b>far less
                crispness loss than mips alone</b>. It needs mips available to bite — and only differs from plain mips
                where the footprint is <b>elongated</b>, i.e. at a <b>grazing angle</b>. On a flat top-down map (pitch 0)
                the footprint is square, so aniso and trilinear look identical.
              </div>
              <div style={{ marginTop: 10, fontSize: 13, color: '#334155' }}>
                1 — enable <b>3D</b>: <button onClick={handleTilt} style={LINK_STYLE}>tilt 44°</button>
                {'  ·  '}
                <button onClick={handleFlat} style={LINK_STYLE}>flat</button>
                {' '}(or use the “3D (tilt)” toggle; then drag to pitch/rotate)
              </div>
              <div style={{ marginTop: 6, fontSize: 13, color: '#334155' }}>
                2 — then compare (look toward the horizon):{' '}
                <button onClick={() => setControls({ lodMaxClamp: 8, maxAnisotropy: 1 })} style={LINK_STYLE}>
                  aniso off
                </button>
                {'  ·  '}
                <button onClick={() => setControls({ lodMaxClamp: 8, maxAnisotropy: 4 })} style={LINK_STYLE}>
                  4×
                </button>
                {'  ·  '}
                <button onClick={() => setControls({ lodMaxClamp: 8, maxAnisotropy: 16 })} style={LINK_STYLE}>
                  16×
                </button>
              </div>
            </div>

            {useMatrix && (
              <div style={{ marginTop: 26, paddingLeft: 15, borderLeft: '3px solid #6366f1' }}>
                <div style={{ fontWeight: 700, marginBottom: 6 }}>LOD × anisotropy matrix</div>
                <div style={{ color: '#334155' }}>
                  Every quad is the <b>same</b> FSE setup (pattern, asset, res, mip margin, seam, fp64) and differs{' '}
                  <b>only</b> in its sampler: rows = <code>lodMaxClamp</code> {LOD_VALUES.join(', ')}, cols ={' '}
                  <code>maxAnisotropy</code> {ANISO_VALUES.map((a) => `${a}×`).join(', ')}. Enable <b>3D</b> to make the
                  anisotropy columns diverge; scan for the crispest + most stable cell.
                </div>
              </div>
            )}

            {useData && patternColumn !== 'fixed' && encoding.legend.length > 0 && (
              <div style={{ marginTop: 26, paddingLeft: 15, borderLeft: '3px solid #6366f1' }}>
                <div style={{ fontWeight: 700, marginBottom: 8 }}>
                  Pattern by <code>{patternColumn}</code>
                </div>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                  {encoding.legend.map((e) => (
                    <div key={e.pattern + e.label} style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                      <img
                        src={patternSwatchUrl(e.pattern)}
                        alt={e.pattern}
                        width={22}
                        height={22}
                        style={{ border: '1px solid #cbd5e1', borderRadius: 3, background: '#fff' }}
                      />
                      <span style={{ fontSize: 13, color: '#334155' }}>{e.label}</span>
                    </div>
                  ))}
                </div>
              </div>
            )}

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
              now: {usingApiClient ? '@carto/api-client atlas' : assetSource} · cell {resolution}px · mips{' '}
              {effLod === 0 ? 'off' : `≤${effLod}`} · aniso {effAniso > 1 ? `${effAniso}×` : 'off'}
            </div>
          </div>
      )}
    </div>
  );
}

import { useEffect, useMemo, useState } from 'react';
import DeckGL from '@deck.gl/react';
import { GeoJsonLayer } from '@deck.gl/layers';
import type { MapViewState } from '@deck.gl/core';
import { useControls } from 'leva';
import { Map } from 'react-map-gl/maplibre';
import 'maplibre-gl/dist/maplibre-gl.css';
import { buildAtlas, FILL_UV_SCALE, PATTERN_KEYS, type AtlasBuild, type PatternAssetSource } from './pattern-atlas';
import { CartoFillStyleExtension } from './CartoFillStyleExtension';

// Natural Earth countries (the dataset deck's own FillStyleExtension example uses).
const COUNTRIES = 'https://d2ad6b4ur7yvpq.cloudfront.net/naturalearth-3.3.0/ne_50m_admin_0_scale_rank.geojson';

// CARTO basemap styles.
const CARTO_STYLES: Record<string, string> = {
  positron: 'https://basemaps.cartocdn.com/gl/positron-gl-style/style.json',
  'dark-matter': 'https://basemaps.cartocdn.com/gl/dark-matter-gl-style/style.json',
  voyager: 'https://basemaps.cartocdn.com/gl/voyager-gl-style/style.json'
};

const INITIAL_VIEW_STATE: MapViewState = { longitude: -3.7, latitude: 40.4, zoom: 4 };

export function FillPatternHacks() {
  const [viewState, setViewState] = useState<MapViewState>(INITIAL_VIEW_STATE);

  const {
    pattern,
    sizing,
    patternSize,
    screenPx,
    lodMaxClamp,
    mipLevels,
    cellSize,
    assetSource,
    seamFix,
    fp64,
    basemap
  } = useControls({
    basemap: { value: 'positron', options: { Positron: 'positron', 'Dark Matter': 'dark-matter', Voyager: 'voyager' } },
    pattern: { value: 'diag-right-medium', options: PATTERN_KEYS as unknown as string[] },
    sizing: { value: 'world', options: { 'World anchored': 'world', 'Follow zoom': 'screen' } },
    // Builder's fillPatternSize: a percent (100% = ×1, so ×0.001–×5) on the auto-computed scale.
    patternSize: { value: 100, min: 0.1, max: 500, step: 0.1, label: 'pattern size %' },
    screenPx: { value: 24, min: 4, max: 200, step: 1, render: (get) => get('sizing') === 'screen' },
    lodMaxClamp: { value: 0, min: 0, max: 8, step: 1, label: 'lodMaxClamp (mips)' },
    mipLevels: { value: 4, min: 1, max: 6, step: 1, label: 'margin mip levels' },
    cellSize: { value: 128, options: { '128px': 128, '256px': 256 } },
    assetSource: { value: 'png', options: ['png', 'svg', 'procedural'] },
    seamFix: { value: false, label: 'seam fix (#7326)' },
    fp64: { value: false, label: 'fp64 origin' }
  });

  // Rebuild the atlas only when the atlas-shaping controls change.
  const [build, setBuild] = useState<AtlasBuild | null>(null);
  useEffect(() => {
    setBuild(buildAtlas({ cellSize, mipLevels, assetSource: assetSource as PatternAssetSource }));
  }, [cellSize, mipLevels, assetSource]);

  const extension = useMemo(() => new CartoFillStyleExtension({ pattern: true, seamFix, fp64 }), [seamFix, fp64]);

  const zoom = viewState.zoom ?? INITIAL_VIEW_STATE.zoom!;
  const cell = build?.cell ?? cellSize;
  // Base scale: world-anchored uses the atlas' scaleAdjustment (fixed geographic size, like
  // Builder); follow-zoom solves for a ~screenPx repeat at the current zoom. The user's
  // `patternSize` multiplies it — the same base × fillPatternSize Builder applies.
  const baseScale =
    sizing === 'world' ? (build?.scaleAdjustment ?? 1) : screenPx / (FILL_UV_SCALE * cell * Math.pow(2, zoom));
  const patternScale = (patternSize / 100) * baseScale;

  const layers = build
    ? [
        new GeoJsonLayer({
          // Shader-affecting controls go in the id so the layer (and its program) rebuilds.
          id: `countries-${cellSize}-${mipLevels}-${assetSource}-${seamFix}-${fp64}-${lodMaxClamp}`,
          data: COUNTRIES,
          stroked: true,
          filled: true,
          getFillColor: [127, 60, 141, 255],
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

  return (
    <>
      <DeckGL
        viewState={viewState}
        onViewStateChange={({ viewState: vs }) => setViewState(vs as MapViewState)}
        controller={true}
        layers={layers}
      >
        <Map mapStyle={CARTO_STYLES[basemap]} />
      </DeckGL>
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
        zoom {zoom.toFixed(2)} · {sizing === 'world' ? 'world-anchored' : 'follow-zoom'} ·{' '}
        {lodMaxClamp === 0 ? 'mips off' : `mips≤${lodMaxClamp}`}
        {seamFix ? ' · seam-fix' : ''}
        {fp64 ? ' · fp64' : ''}
      </div>
    </>
  );
}

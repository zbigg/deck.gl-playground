import { useEffect, useMemo, useState } from 'react';
import DeckGL from '@deck.gl/react';
import { GeoJsonLayer } from '@deck.gl/layers';
import type { MapViewState } from '@deck.gl/core';
import { useControls } from 'leva';
import { buildAtlas, FILL_UV_SCALE, PATTERN_KEYS, type AtlasBuild, type PatternAssetSource } from './pattern-atlas';
import { CartoFillStyleExtension } from './CartoFillStyleExtension';

// Natural Earth countries (the dataset deck's own FillStyleExtension example uses).
const COUNTRIES = 'https://d2ad6b4ur7yvpq.cloudfront.net/naturalearth-3.3.0/ne_50m_admin_0_scale_rank.geojson';

const INITIAL_VIEW_STATE: MapViewState = { longitude: -3.7, latitude: 40.4, zoom: 4 };

export function FillPatternHacks() {
  const [viewState, setViewState] = useState<MapViewState>(INITIAL_VIEW_STATE);

  const {
    pattern,
    sizing,
    worldScale,
    screenPx,
    lodMaxClamp,
    mipLevels,
    cellSize,
    assetSource,
    seamFix,
    fp64
  } = useControls({
    pattern: { value: 'diag-right-medium', options: PATTERN_KEYS as unknown as string[] },
    sizing: { value: 'world', options: { 'World anchored': 'world', 'Follow zoom': 'screen' } },
    worldScale: { value: 50, min: 1, max: 2000, step: 1, render: (get) => get('sizing') === 'world' },
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
  // World-anchored: fixed geographic size (shrinks on screen as you zoom out -> Moiré).
  // Follow-zoom: solve getFillPatternScale so the repeat is ~screenPx CSS pixels at any zoom.
  const patternScale =
    sizing === 'world'
      ? worldScale * (build?.scaleAdjustment ?? 1)
      : screenPx / (FILL_UV_SCALE * cell * Math.pow(2, zoom));

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
        style={{ background: '#0b0f14' }}
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
        zoom {zoom.toFixed(2)} · {sizing === 'world' ? 'world-anchored' : 'follow-zoom'} ·{' '}
        {lodMaxClamp === 0 ? 'mips off' : `mips≤${lodMaxClamp}`}
        {seamFix ? ' · seam-fix' : ''}
        {fp64 ? ' · fp64' : ''}
      </div>
    </>
  );
}

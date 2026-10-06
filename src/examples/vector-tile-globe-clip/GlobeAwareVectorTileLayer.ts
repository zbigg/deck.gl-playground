import { VectorTileLayer } from '@deck.gl/carto';
import { ClipExtension } from '@deck.gl/extensions';
import type { Layer } from '@deck.gl/core';
import { GlobeClipExtension } from './GlobeClipExtension';

const CLIPPED_SUBLAYERS = ['polygons-fill', 'polygons-stroke', 'linestrings'];

type RenderResult = ReturnType<VectorTileLayer['renderSubLayers']>;

// Method #2: on a globe, swap the (flat-only) ClipExtension for a globe-aware one that clips in
// lng/lat space. The tile bounds (`clipBounds`) are already on each sub-layer's props, so swapping
// the extension instance is enough. On mercator it leaves the stock ClipExtension untouched.
export class GlobeAwareVectorTileLayer extends VectorTileLayer {
  renderSubLayers(props: Parameters<VectorTileLayer['renderSubLayers']>[0]): RenderResult {
    const result = super.renderSubLayers(props);
    const onGlobe = 'resolution' in this.context.viewport;
    if (!onGlobe || !result) return result;
    const globeClip = new GlobeClipExtension();
    const layers = Array.isArray(result) ? result : [result];
    return layers.map((layer) => (layer ? swapClip(layer, globeClip) : layer)) as RenderResult;
  }
}

function swapClip<L extends Layer>(layer: L, globeClip: GlobeClipExtension): L {
  const subLayerProps = (layer.props as { _subLayerProps?: Record<string, { extensions?: unknown[] }> })
    ._subLayerProps;
  if (!subLayerProps) return layer;

  const next: Record<string, unknown> = { ...subLayerProps };
  let changed = false;
  for (const id of CLIPPED_SUBLAYERS) {
    const sub = subLayerProps[id];
    const extensions = sub?.extensions;
    if (!extensions?.some((e) => e instanceof ClipExtension)) continue;
    next[id] = { ...sub, extensions: extensions.map((e) => (e instanceof ClipExtension ? globeClip : e)) };
    changed = true;
  }
  return changed ? (layer.clone({ _subLayerProps: next } as unknown as Partial<L['props']>) as L) : layer;
}

import { VectorTileLayer } from '@deck.gl/carto';
import { ClipExtension } from '@deck.gl/extensions';
import type { Layer } from '@deck.gl/core';

// The sub-layers VectorTileLayer.renderSubLayers wraps with ClipExtension for binary tiles.
const CLIPPED_SUBLAYERS = ['polygons-fill', 'polygons-stroke', 'linestrings'];

type RenderResult = ReturnType<VectorTileLayer['renderSubLayers']>;

// ClipExtension discards fragments outside an axis-aligned lng/lat box — meaningless in the 3D
// sphere common space a GlobeViewport uses, so it wrongly discards ~40% of every binary tile.
// Base MVTLayer already guards its clip with `!viewport.resolution`; VectorTileLayer does not.
export class PatchedVectorTileLayer extends VectorTileLayer {
  renderSubLayers(props: Parameters<VectorTileLayer['renderSubLayers']>[0]): RenderResult {
    const result = super.renderSubLayers(props);
    const onGlobe = 'resolution' in this.context.viewport;
    if (!onGlobe || !result) return result;
    const layers = Array.isArray(result) ? result : [result];
    return layers.map((layer) => (layer ? stripClip(layer) : layer)) as RenderResult;
  }
}

function stripClip<L extends Layer>(layer: L): L {
  const subLayerProps = (layer.props as { _subLayerProps?: Record<string, { extensions?: unknown[] }> })
    ._subLayerProps;
  if (!subLayerProps) return layer;

  const next: Record<string, unknown> = { ...subLayerProps };
  let changed = false;
  for (const id of CLIPPED_SUBLAYERS) {
    const sub = subLayerProps[id];
    const extensions = sub?.extensions;
    if (!extensions?.some((e) => e instanceof ClipExtension)) continue;
    next[id] = { ...sub, extensions: extensions.filter((e) => !(e instanceof ClipExtension)) };
    changed = true;
  }
  return changed ? (layer.clone({ _subLayerProps: next } as unknown as Partial<L['props']>) as L) : layer;
}

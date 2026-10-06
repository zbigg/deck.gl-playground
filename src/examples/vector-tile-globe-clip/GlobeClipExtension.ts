import type { ShaderModule } from '@luma.gl/shadertools';
import { LayerExtension } from '@deck.gl/core';
import type { Layer } from '@deck.gl/core';

// Draft of ClipExtension method #2: clip in geographic (lng/lat) space instead of the projected
// common-space box, so it is correct on a globe. Keeps the per-pixel discard, keeps the overdraw
// protection — only the test space changes. This is the cheap variant: it compares the fragment's
// pre-projection lng/lat (`geometry.worldPosition.xy`) against the raw tile bounds, which is fp32
// and so loses precision at high zoom (deck issue #9059). The precise variant inverse-maps the
// common-space position.xyz back to lng/lat instead.
const defaultProps = { clipBounds: [0, 0, 1, 1] };

export type GlobeClipExtensionProps = {
  /** Tile bounds for clipping, in `[west, south, east, north]` lng/lat. */
  clipBounds?: Readonly<[number, number, number, number]>;
};

const shaderFunction = /* glsl */ `
layout(std140) uniform globeClipUniforms {
  vec4 bounds;
} globeClip;

bool globeClip_isInBounds(vec2 lngLat) {
  return lngLat.x >= globeClip.bounds[0] && lngLat.y >= globeClip.bounds[1] && lngLat.x < globeClip.bounds[2] && lngLat.y < globeClip.bounds[3];
}
`;

type GlobeClipModuleProps = { bounds: Readonly<[number, number, number, number]> };

const shaderModule: ShaderModule<GlobeClipModuleProps> = {
  name: 'globeClip',
  fs: shaderFunction,
  uniformTypes: { bounds: 'vec4<f32>' }
};

const injection = {
  'vs:#decl': /* glsl */ `out vec2 globeClip_lngLat;`,
  'vs:DECKGL_FILTER_GL_POSITION': /* glsl */ `globeClip_lngLat = geometry.worldPosition.xy;`,
  'fs:#decl': /* glsl */ `in vec2 globeClip_lngLat;`,
  'fs:DECKGL_FILTER_COLOR': /* glsl */ `if (!globeClip_isInBounds(globeClip_lngLat)) discard;`
};

export class GlobeClipExtension extends LayerExtension {
  static defaultProps = defaultProps;
  static extensionName = 'GlobeClipExtension';

  getShaders(this: Layer<GlobeClipExtensionProps>) {
    if (this.context.device.type === 'webgpu') return {};
    return { modules: [shaderModule], inject: injection };
  }

  draw(this: Layer<Required<GlobeClipExtensionProps>>): void {
    this.setShaderModuleProps({ globeClip: { bounds: this.props.clipBounds } });
  }
}

import type { ShaderModule } from '@luma.gl/shadertools';
import { LayerExtension } from '@deck.gl/core';
import type { Layer } from '@deck.gl/core';

// Precise variant of ClipExtension method #2. Instead of comparing fp32 lng/lat (which loses
// precision at high zoom, deck #9059), it recovers lng/lat per fragment from the globe common-space
// sphere position — the inverse of deck's project_globe_:
//   P = D * vec3(sin(λ)cos(φ), -cos(λ)cos(φ), sin(φ))  →  λ = atan2(x, -y),  φ = asin(z / |P|)
// The sphere coordinates are O(GLOBE_RADIUS) and well-conditioned, so the recovered angle is far
// more accurate than a raw lng/lat varying. Constant-free; needs only geometry.position.xyz.
const defaultProps = { clipBounds: [0, 0, 1, 1] };

export type GlobeClipExtensionPreciseProps = {
  /** Tile bounds for clipping, in `[west, south, east, north]` lng/lat. */
  clipBounds?: Readonly<[number, number, number, number]>;
};

const shaderFunction = /* glsl */ `
layout(std140) uniform globeClipPUniforms {
  vec4 bounds;
} globeClipP;

bool globeClipP_isInBounds(vec3 P) {
  float lng = degrees(atan(P.x, -P.y));
  float lat = degrees(asin(clamp(P.z / length(P), -1.0, 1.0)));
  return lng >= globeClipP.bounds[0] && lat >= globeClipP.bounds[1] && lng < globeClipP.bounds[2] && lat < globeClipP.bounds[3];
}
`;

type GlobeClipPModuleProps = { bounds: Readonly<[number, number, number, number]> };

const shaderModule: ShaderModule<GlobeClipPModuleProps> = {
  name: 'globeClipP',
  fs: shaderFunction,
  uniformTypes: { bounds: 'vec4<f32>' }
};

const injection = {
  'vs:#decl': /* glsl */ `out vec3 globeClipP_commonPos;`,
  'vs:DECKGL_FILTER_GL_POSITION': /* glsl */ `globeClipP_commonPos = geometry.position.xyz;`,
  'fs:#decl': /* glsl */ `in vec3 globeClipP_commonPos;`,
  'fs:DECKGL_FILTER_COLOR': /* glsl */ `if (!globeClipP_isInBounds(globeClipP_commonPos)) discard;`
};

export class GlobeClipExtensionPrecise extends LayerExtension {
  static defaultProps = defaultProps;
  static extensionName = 'GlobeClipExtensionPrecise';

  getShaders(this: Layer<GlobeClipExtensionPreciseProps>) {
    if (this.context.device.type === 'webgpu') return {};
    return { modules: [shaderModule], inject: injection };
  }

  draw(this: Layer<Required<GlobeClipExtensionPreciseProps>>): void {
    this.setShaderModuleProps({ globeClipP: { bounds: this.props.clipBounds } });
  }
}

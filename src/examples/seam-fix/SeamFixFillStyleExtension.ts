// FillStyleExtension with only the seam fix — the minimal counterpart to dense-buildings'
// NoFp64FillStyleExtension, which isolates the fp64 axis. This one isolates the seam axis and
// nothing else.
//
// deck.gl #7326: deck emulates GL_REPEAT for the pattern with mod() in the fragment shader.
// The hardware picks the mip level from the screen-space derivative of the texture coordinate,
// but mod() makes that coordinate jump from 1 back to 0 at every tile boundary — a one-texel
// span with a near-infinite derivative, so the sampler drops to the coarsest mip right on the
// seam and paints a dark/blurred line. The phase math is left exactly as stock deck computes
// it; only the LOD is taken from the continuous (pre-mod) coordinate via textureGrad. No CPU
// work, no extra uniforms, no fp64 — so draw()/getUniforms stay untouched.

import type { Layer } from '@deck.gl/core';
import { FillStyleExtension, type FillStyleExtensionProps } from '@deck.gl/extensions';

// FILL_UV_SCALE below is deck's own fill-shader constant, not a JS value — the seam fix does
// no CPU-side math, so nothing needs importing here.
const SEAM_FIX_FS = /* glsl */ `
    if (fill.patternEnabled) {
      vec2 scale = FILL_UV_SCALE * fill_patternPlacement.zw;
      vec2 patternUV = mod(mod(fill.uvCoordinateOrigin, scale) + fill.uvCoordinateOrigin64Low + fill_uv, scale) / scale;
      patternUV = mod(fill_patternPlacement.xy + patternUV, 1.0);

      vec2 texCoords = fill_patternBounds.xy + fill_patternBounds.zw * patternUV;

      // LOD from the continuous coordinate, not the mod()-wrapped one — the seam fix.
      vec2 gradX = fill_patternBounds.zw * (dFdx(fill_uv) / scale);
      vec2 gradY = fill_patternBounds.zw * (dFdy(fill_uv) / scale);
      vec4 patternColor = textureGrad(fill_patternTexture, texCoords, gradX, gradY);

      color.a *= patternColor.a;
      if (!fill.patternMask) {
        color.rgb = patternColor.rgb;
      }
    }
  `;

type FillShaderModule = { name?: string; inject?: Record<string, string>; instance?: unknown };

function patchFill(module: FillShaderModule): FillShaderModule {
  return {
    ...module,
    inject: { ...module.inject, 'fs:DECKGL_FILTER_COLOR': SEAM_FIX_FS },
    // Drop luma's cached instance: spreading the module copies it, and initializeShaderModule
    // early-returns when instance is set — reusing the ORIGINAL injections and silently dropping
    // ours once a stock FillStyleExtension elsewhere has initialized the shared fill singleton.
    instance: undefined
  };
}

export class SeamFixFillStyleExtension extends FillStyleExtension {
  getShaders(this: Layer<FillStyleExtensionProps>, extension: this) {
    const shaders = super.getShaders(extension);
    if (!shaders?.modules) return shaders;
    return {
      ...shaders,
      modules: shaders.modules.map((m: FillShaderModule) => (m?.name === 'fill' ? patchFill(m) : m))
    };
  }
}

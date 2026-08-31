// A FillStyleExtension with two experimental, per-instance-toggleable shader fixes,
// ported from CARTO's Builder. Flags are constructor options here (not localStorage) so the
// playground can flip them live by re-instantiating the extension.
//
//   seamFix — deck.gl #7326: mipmapping an atlas makes the mod()-REPEAT emulation spike the
//     texCoord derivative at tile boundaries and pick a too-coarse mip there (a seam). Keep
//     the mod() sampling but take the LOD from the continuous coordinate via textureGrad.
//   fp64 — the world-anchored pattern phase is `mod(uvCoordinateOrigin + fill_uv, scale)`;
//     reducing the large origin in fp32 loses precision at high zoom (~z15+), destroying the
//     pattern. Reduce the origin mod scale on the CPU in fp64 and feed a small residual.

import { Layer, fp64LowPart } from '@deck.gl/core';
import { FillStyleExtension } from '@deck.gl/extensions';
import type { FillStyleExtensionProps } from '@deck.gl/extensions';

// deck's meters -> common-space constant (mirrors FILL_UV_SCALE in the fill shader).
const FILL_UV_SCALE = 512 / 40_000_000;

const PATTERN_SEAM_FIX_FS = /* glsl */ `
    if (fill.patternEnabled) {
      vec2 scale = FILL_UV_SCALE * fill_patternPlacement.zw;
      vec2 patternUV = mod(mod(fill.uvCoordinateOrigin, scale) + fill.uvCoordinateOrigin64Low + fill_uv, scale) / scale;
      patternUV = mod(fill_patternPlacement.xy + patternUV, 1.0);

      vec2 texCoords = fill_patternBounds.xy + fill_patternBounds.zw * patternUV;

      vec2 gradX = fill_patternBounds.zw * (dFdx(fill_uv) / scale);
      vec2 gradY = fill_patternBounds.zw * (dFdy(fill_uv) / scale);
      vec4 patternColor = textureGrad(fill_patternTexture, texCoords, gradX, gradY);

      color.a *= patternColor.a;
      if (!fill.patternMask) {
        color.rgb = patternColor.rgb;
      }
    }
  `;

// The pattern repeat in common-space units — uniform when getFillPatternScale is a constant
// and every atlas frame is the same size (true here), which is what lets the origin be
// reduced once on the CPU. undefined otherwise -> leave deck's path untouched.
function patternScaleCommon(props: FillStyleExtensionProps): [number, number] | undefined {
  const { getFillPatternScale: scale, fillPatternMapping: mapping } = props;
  if (typeof scale !== 'number' || typeof mapping !== 'object' || mapping === null) return undefined;
  const frame = Object.values(mapping)[0];
  if (!frame) return undefined;
  return [FILL_UV_SCALE * scale * frame.width, FILL_UV_SCALE * scale * frame.height];
}

// `x mod scale` is invariant under subtracting whole multiples of scale, so the phase is
// identical while the value the fp32 shader sees is < scale. `origin` is already the full
// double — deck only splits it into hi/lo on the way to the uniform buffer.
function reduceOriginAxis(origin: number, scale: number): { hi: number; low: number } {
  const reduced = origin % scale;
  return { hi: reduced, low: fp64LowPart(reduced) };
}

/* eslint-disable @typescript-eslint/no-explicit-any -- deck's fill shader module is untyped */
type FillShaderModule = {
  name?: string;
  inject?: Record<string, string>;
  getUniforms?: (props: any, oldUniforms?: any) => any;
};
/* eslint-enable @typescript-eslint/no-explicit-any */

function patchFill(module: FillShaderModule, ext: CartoFillStyleExtension): FillShaderModule {
  let patched = module;
  if (ext.seamFix) {
    patched = { ...patched, inject: { ...patched.inject, 'fs:DECKGL_FILTER_COLOR': PATTERN_SEAM_FIX_FS } };
  }
  if (ext.fp64) {
    const base = patched.getUniforms;
    patched = {
      ...patched,
      getUniforms: (props, oldUniforms) => {
        const uniforms = base ? base(props, oldUniforms) : {};
        const scale: [number, number] | undefined = props?.patternScaleCommon;
        const origin: number[] | undefined = uniforms?.uvCoordinateOrigin;
        if (scale && origin) {
          const x = reduceOriginAxis(origin[0], scale[0]);
          const y = reduceOriginAxis(origin[1], scale[1]);
          uniforms.uvCoordinateOrigin = [x.hi, y.hi];
          uniforms.uvCoordinateOrigin64Low = [x.low, y.low];
        }
        return uniforms;
      }
    };
  }
  return patched;
}

export type CartoFillOpts = { pattern?: boolean; seamFix?: boolean; fp64?: boolean };

export class CartoFillStyleExtension extends FillStyleExtension {
  seamFix: boolean;
  fp64: boolean;

  constructor(opts: CartoFillOpts = {}) {
    super({ pattern: opts.pattern ?? false });
    this.seamFix = !!opts.seamFix;
    this.fp64 = !!opts.fp64;
  }

  // So deck treats instances with different flags as different extensions.
  equals(other: CartoFillStyleExtension): boolean {
    return super.equals(other) && this.seamFix === other.seamFix && this.fp64 === other.fp64;
  }

  getShaders(this: Layer<FillStyleExtensionProps>, extension: this) {
    const shaders = super.getShaders(extension);
    if (!shaders?.modules) return shaders;
    return {
      ...shaders,
      modules: shaders.modules.map((m: FillShaderModule) => (m?.name === 'fill' ? patchFill(m, extension) : m))
    };
  }

  draw(
    this: Layer<FillStyleExtensionProps>,
    params: { shaderModuleProps: { project: unknown } },
    extension: this
  ) {
    if (!extension.fp64) {
      super.draw(params, extension);
      return;
    }
    if (!extension.isEnabled(this)) return;
    const { fillPatternAtlas, fillPatternEnabled, fillPatternMask } = this.props;
    this.setShaderModuleProps({
      fill: {
        project: params.shaderModuleProps.project,
        fillPatternEnabled,
        fillPatternMask,
        fillPatternTexture: fillPatternAtlas || (this.state as { emptyTexture?: unknown }).emptyTexture,
        patternScaleCommon: patternScaleCommon(this.props)
      }
    });
  }
}

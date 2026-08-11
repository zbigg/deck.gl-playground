// FillStyleExtension with the world-anchored pattern phase reduced on the CPU, in fp64,
// instead of patched up in the shader with an fp64 low part.
//
// deck's fragment shader computes the phase as
//   mod(mod(uvCoordinateOrigin, cell) + uvCoordinateOrigin64Low + fill_uv, cell)
// where `uvCoordinateOrigin` is the common-space position of the projection origin — up to
// 512 (the whole world), while `cell` at high zoom is ~1e-5. Reducing one against the other
// in fp32 is where the precision goes: `cell * floor(origin / cell)` rounds to ~3e-5 common
// units, which is several screen pixels of phase error past z16, and a large fraction of a
// cell once the cell itself is that small.
//
// The reduction is a pure function of two numbers JS already holds at full precision, so do
// it in JS: `origin mod cell` is invariant under subtracting whole multiples of cell, so the
// phase is unchanged, and what the shader receives is already < cell. fp32 then resolves it
// to ~1e-11 common units and the low part has nothing left to correct — the shader needs no
// fp64 at all.
//
// The catch: `cell` is per-instance in the shader (fillPatternScales × the frame size), while
// the origin is a uniform, so the CPU can only reduce against a cell every instance agrees on.
// `patternCellCommon` returns null when that does not hold, and the extension leaves deck's
// original path in place.

import { Layer } from '@deck.gl/core';
import { FillStyleExtension } from '@deck.gl/extensions';
import type { FillStyleExtensionProps } from '@deck.gl/extensions';

// deck's meters -> common-space constant (mirrors FILL_UV_SCALE in the fill shader).
const FILL_UV_SCALE = 512 / 40_000_000;

const PATTERN_FS = /* glsl */ `
    if (fill.patternEnabled) {
      vec2 scale = FILL_UV_SCALE * fill_patternPlacement.zw;
      vec2 patternUV = mod(fill.uvCoordinateOrigin + fill_uv, scale) / scale;
      patternUV = mod(fill_patternPlacement.xy + patternUV, 1.0);

      vec2 texCoords = fill_patternBounds.xy + fill_patternBounds.zw * patternUV;

      vec4 patternColor = texture(fill_patternTexture, texCoords);
      color.a *= patternColor.a;
      if (!fill.patternMask) {
        color.rgb = patternColor.rgb;
      }
    }
  `;

// The pattern repeat in common-space units, or null when instances disagree on it and a
// single uniform reduction would be wrong for some of them.
function patternCellCommon(props: FillStyleExtensionProps): [number, number] | null {
  const { getFillPatternScale: scale, fillPatternMapping: mapping } = props;
  if (typeof scale !== 'number' || typeof mapping !== 'object' || mapping === null) return null;
  const frames = Object.values(mapping);
  const first = frames[0];
  if (!first) return null;
  if (frames.some((f) => f.width !== first.width || f.height !== first.height)) return null;
  return [FILL_UV_SCALE * scale * first.width, FILL_UV_SCALE * scale * first.height];
}

// Positive remainder — GLSL mod() is floor-based, JS % is truncation-based.
function positiveMod(x: number, m: number): number {
  const r = x % m;
  return r < 0 ? r + m : r;
}

/* eslint-disable @typescript-eslint/no-explicit-any -- deck's fill shader module is untyped */
type FillShaderModule = {
  name?: string;
  inject?: Record<string, string>;
  getUniforms?: (props: any, oldUniforms?: any) => any;
};
/* eslint-enable @typescript-eslint/no-explicit-any */

function patchFill(module: FillShaderModule): FillShaderModule {
  const base = module.getUniforms;
  return {
    ...module,
    inject: { ...module.inject, 'fs:DECKGL_FILTER_COLOR': PATTERN_FS },
    getUniforms: (props, oldUniforms) => {
      const uniforms = base ? base(props, oldUniforms) : {};
      const cell: [number, number] | null = props?.patternCellCommon ?? null;
      const origin: number[] | undefined = uniforms?.uvCoordinateOrigin;
      const low: number[] | undefined = uniforms?.uvCoordinateOrigin64Low;
      if (cell && origin && low) {
        uniforms.uvCoordinateOrigin = [
          positiveMod(origin[0] + low[0], cell[0]),
          positiveMod(origin[1] + low[1], cell[1])
        ];
        uniforms.uvCoordinateOrigin64Low = [0, 0];
      }
      return uniforms;
    }
  };
}

export class NoFp64FillStyleExtension extends FillStyleExtension {
  getShaders(this: Layer<FillStyleExtensionProps>, extension: this) {
    const shaders = super.getShaders(extension);
    if (!shaders?.modules) return shaders;
    return {
      ...shaders,
      modules: shaders.modules.map((m: FillShaderModule) => (m?.name === 'fill' ? patchFill(m) : m))
    };
  }

  draw(
    this: Layer<FillStyleExtensionProps>,
    params: { shaderModuleProps: { project: unknown } },
    extension: this
  ) {
    if (!extension.isEnabled(this)) return;
    const { fillPatternAtlas, fillPatternEnabled, fillPatternMask } = this.props;
    this.setShaderModuleProps({
      fill: {
        project: params.shaderModuleProps.project,
        fillPatternEnabled,
        fillPatternMask,
        fillPatternTexture: fillPatternAtlas || (this.state as { emptyTexture?: unknown }).emptyTexture,
        patternCellCommon: patternCellCommon(this.props)
      }
    });
  }
}

import { HalfFloatType, LinearFilter, RGBAFormat, WebGLRenderTarget } from 'three';

export { FullScreenQuad } from 'three/examples/jsm/postprocessing/Pass.js';

/** Vertex shader for FullScreenQuad passes. */
export const FSQ_VERT = /* glsl */ `
varying vec2 vUv;
void main() {
  vUv = uv;
  gl_Position = vec4(position.xy, 0.0, 1.0);
}
`;

/** Linear-filtered HDR colour target without depth, for post-processing. */
export function createColorTarget(width = 2, height = 2): WebGLRenderTarget {
  return new WebGLRenderTarget(width, height, {
    type: HalfFloatType,
    format: RGBAFormat,
    minFilter: LinearFilter,
    magFilter: LinearFilter,
    depthBuffer: false,
    stencilBuffer: false,
    generateMipmaps: false,
  });
}

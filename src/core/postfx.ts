import * as THREE from 'three';
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js';
import { GTAOPass } from 'three/examples/jsm/postprocessing/GTAOPass.js';
import { OutputPass } from 'three/examples/jsm/postprocessing/OutputPass.js';
import { ShaderPass } from 'three/examples/jsm/postprocessing/ShaderPass.js';

// Cinematic post-processing stack (AAA look pass). Sits between the raw render
// and the screen: ambient occlusion for grounded contact shadows, bloom for
// glowing lava/ice/neon, then a final grade (tone curve, per-family color
// tint, vignette, subtle film grain). Quality-tiered so mobile can drop the
// expensive passes. Gameplay is untouched — this is purely presentation.

// Final grade shader: contrast + saturation + color tint + vignette + grain.
const GradeShader = {
  uniforms: {
    tDiffuse: { value: null as THREE.Texture | null },
    uTime: { value: 0 },
    uContrast: { value: 1.06 },
    uSaturation: { value: 1.12 },
    uTint: { value: new THREE.Color(1, 1, 1) },
    uTintAmt: { value: 0.0 },
    uVignette: { value: 0.9 },
    uGrain: { value: 0.04 },
  },
  vertexShader: /* glsl */ `
    varying vec2 vUv;
    void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }
  `,
  fragmentShader: /* glsl */ `
    uniform sampler2D tDiffuse;
    uniform float uTime, uContrast, uSaturation, uTintAmt, uVignette, uGrain;
    uniform vec3 uTint;
    varying vec2 vUv;
    float hash(vec2 p){ return fract(sin(dot(p, vec2(12.9898,78.233))) * 43758.5453); }
    void main() {
      vec3 c = texture2D(tDiffuse, vUv).rgb;
      // Contrast around mid-grey.
      c = (c - 0.5) * uContrast + 0.5;
      // Saturation.
      float l = dot(c, vec3(0.2126, 0.7152, 0.0722));
      c = mix(vec3(l), c, uSaturation);
      // Family color tint (multiply toward tint in shadows/mids).
      c = mix(c, c * uTint, uTintAmt);
      // Vignette.
      vec2 d = vUv - 0.5;
      float vig = smoothstep(0.85, uVignette * 0.35, dot(d, d) * 2.2);
      c *= mix(1.0, vig, 0.6);
      // Subtle animated film grain.
      float g = (hash(vUv * vec2(1024.0) + uTime) - 0.5) * uGrain;
      c += g;
      gl_FragColor = vec4(clamp(c, 0.0, 1.0), 1.0);
    }
  `,
};

export type PostTier = 'off' | 'low' | 'medium' | 'high' | 'ultra';

// Per-family cinematic grade — a warm/cool tint, bloom strength and exposure
// that give each world its own mood. Keyed by family id (maps.ts).
export const FAMILY_GRADE: Record<string, { tint: number; tintAmt: number; bloom: number; exposure: number }> = {
  frost: { tint: 0xbfe0ff, tintAmt: 0.18, bloom: 0.55, exposure: 1.08 },
  inferno: { tint: 0xffb070, tintAmt: 0.24, bloom: 0.85, exposure: 1.12 },
  dune: { tint: 0xffe0a0, tintAmt: 0.2, bloom: 0.45, exposure: 1.14 },
  wildwood: { tint: 0xcfeeb0, tintAmt: 0.16, bloom: 0.5, exposure: 1.06 },
  sky: { tint: 0xe0f0ff, tintAmt: 0.14, bloom: 0.6, exposure: 1.12 },
  mech: { tint: 0x9fd6ff, tintAmt: 0.2, bloom: 0.7, exposure: 1.0 },
  pirate: { tint: 0xbfe4ff, tintAmt: 0.16, bloom: 0.5, exposure: 1.08 },
  classic: { tint: 0xc8b0ff, tintAmt: 0.22, bloom: 0.75, exposure: 1.04 },
  lab: { tint: 0xc8d0ff, tintAmt: 0.1, bloom: 0.4, exposure: 1.0 },
};

export class PostFX {
  private composer: EffectComposer;
  private renderPass: RenderPass;
  private bloom: UnrealBloomPass;
  private gtao: GTAOPass | null = null;
  private grade: ShaderPass;
  private output: OutputPass;
  enabled = true;

  constructor(
    private renderer: THREE.WebGLRenderer,
    private scene: THREE.Scene,
    private camera: THREE.Camera,
  ) {
    this.composer = new EffectComposer(renderer);
    this.composer.setSize(innerWidth, innerHeight);
    this.composer.setPixelRatio(Math.min(devicePixelRatio, 2));

    this.renderPass = new RenderPass(scene, camera);
    this.composer.addPass(this.renderPass);

    // Ambient occlusion — grounds characters/props with soft contact shadow.
    this.gtao = new GTAOPass(scene, camera, innerWidth, innerHeight);
    (this.gtao as any).output = (GTAOPass as any).OUTPUT?.Default ?? 0;
    this.gtao.enabled = true;
    this.composer.addPass(this.gtao);

    // Bloom — lava glow, ice sparkle, neon, ability FX.
    this.bloom = new UnrealBloomPass(new THREE.Vector2(innerWidth, innerHeight), 0.5, 0.85, 0.82);
    this.composer.addPass(this.bloom);

    // Final grade.
    this.grade = new ShaderPass(GradeShader as any);
    this.composer.addPass(this.grade);

    // Tone mapping / sRGB output.
    this.output = new OutputPass();
    this.composer.addPass(this.output);

    // ACES cinematic tone mapping on the renderer.
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1.05;

    this.setTier('high');
  }

  /** Per-family grade: color tint + bloom strength, called on match start. */
  setGrade(opts: { tint?: number; tintAmt?: number; bloom?: number; exposure?: number }) {
    const u = this.grade.uniforms;
    if (opts.tint !== undefined) (u.uTint.value as THREE.Color).setHex(opts.tint);
    if (opts.tintAmt !== undefined) u.uTintAmt.value = opts.tintAmt;
    if (opts.bloom !== undefined) this.bloom.strength = opts.bloom;
    if (opts.exposure !== undefined) this.renderer.toneMappingExposure = opts.exposure;
  }

  setCamera(camera: THREE.Camera) {
    this.renderPass.camera = camera;
    if (this.gtao) (this.gtao as any).camera = camera;
  }

  setTier(tier: PostTier) {
    this.enabled = tier !== 'off';
    if (this.gtao) this.gtao.enabled = tier === 'high' || tier === 'ultra';
    this.bloom.enabled = tier !== 'off';
    // Cheaper bloom resolution on low.
    this.bloom.strength = tier === 'low' ? 0.35 : this.bloom.strength;
    const grain = this.grade.uniforms.uGrain;
    grain.value = tier === 'ultra' ? 0.05 : tier === 'off' ? 0 : 0.035;
  }

  setSize() {
    this.composer.setSize(innerWidth, innerHeight);
    this.bloom.setSize(innerWidth, innerHeight);
    if (this.gtao) this.gtao.setSize(innerWidth, innerHeight);
  }

  render(dt: number) {
    this.grade.uniforms.uTime.value += dt;
    if (this.enabled) this.composer.render();
    else this.renderer.render(this.scene, this.camera);
  }
}

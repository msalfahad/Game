import * as THREE from 'three';
import type { FamilyDef, FloorStyle } from '../data/maps';

// Shader-driven animated skydome — a big inverted sphere with a per-family sky:
// flowing aurora (ice), ember firestorm (lava), hazy sun (desert), drifting
// clouds (forest/sky/pirate), twinkling starfield (neon). Replaces the flat
// 2-stop gradient background with a living sky. Purely presentation; ticks a
// single time uniform per frame.

const STYLE_IDX: Record<FloorStyle, number> = {
  ice: 0, lava: 1, desert: 2, forest: 3, sky: 4, mech: 5, pirate: 6, neon: 7, greybox: 8,
};

const vert = /* glsl */ `
  varying vec3 vDir;
  void main() {
    vDir = normalize(position);
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;

const frag = /* glsl */ `
  precision highp float;
  varying vec3 vDir;
  uniform float uTime;
  uniform int uStyle;
  uniform vec3 uTop;
  uniform vec3 uBot;
  uniform vec3 uTrim;

  // --- value noise / fbm ---
  float hash(vec2 p){ return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453123); }
  float noise(vec2 p){
    vec2 i = floor(p), f = fract(p);
    vec2 u = f*f*(3.0-2.0*f);
    return mix(mix(hash(i+vec2(0,0)), hash(i+vec2(1,0)), u.x),
               mix(hash(i+vec2(0,1)), hash(i+vec2(1,1)), u.x), u.y);
  }
  float fbm(vec2 p){
    float v = 0.0, a = 0.5;
    for(int i=0;i<5;i++){ v += a*noise(p); p *= 2.02; a *= 0.5; }
    return v;
  }

  void main(){
    vec3 d = normalize(vDir);
    float h = clamp(d.y * 0.5 + 0.5, 0.0, 1.0);           // 0 horizon .. 1 zenith
    float az = atan(d.z, d.x);                             // azimuth
    vec3 col = mix(uBot, uTop, pow(h, 0.85));

    // Stars (night styles: ice, neon).
    if(uStyle == 0 || uStyle == 7){
      vec2 sp = vec2(az * 3.0, d.y * 6.0);
      float s = step(0.985, hash(floor(sp * 40.0)));
      float tw = 0.6 + 0.4 * sin(uTime * 2.0 + hash(floor(sp*40.0)) * 30.0);
      col += vec3(s * tw) * smoothstep(0.15, 0.6, h);
    }

    if(uStyle == 0){
      // Aurora: flowing green/teal/purple curtains across the sky, low enough
      // to sit in the iso-camera framing.
      float band = 0.0;
      for(int i=0;i<3;i++){
        float fi = float(i);
        float y = 0.40 + fi*0.13;
        float wob = fbm(vec2(az*1.5 + uTime*0.18 + fi, fi*3.0)) * 0.18;
        float b = smoothstep(0.12, 0.0, abs(h - (y + wob)));
        // Vertical curtain streaks.
        float streak = 0.7 + 0.5 * fbm(vec2(az*8.0, uTime*0.25 + fi));
        band += b * (0.9 - fi*0.18) * streak;
      }
      vec3 aur = mix(vec3(0.2,1.0,0.6), vec3(0.55,0.4,1.0), 0.5+0.5*sin(az*2.0+uTime*0.3));
      col += aur * band * smoothstep(0.2, 0.5, h) * 1.3;
    } else if(uStyle == 1){
      // Ember firestorm: hot glow at the horizon, rising flicker, dark smoke top.
      float glow = pow(1.0 - h, 3.0);
      col = mix(col, vec3(1.0, 0.35, 0.08), glow * 0.8);
      float f = fbm(vec2(az*2.0, h*3.0 - uTime*0.4));
      col += vec3(1.0,0.4,0.1) * smoothstep(0.55,0.9,f) * (1.0-h) * 0.6;
      col = mix(col, uTop*0.5, smoothstep(0.6,1.0,h)); // smoke ceiling
    } else if(uStyle == 2 || uStyle == 4){
      // Sun + haze (desert / sky) with a bright disc and drifting clouds.
      vec3 sunDir = normalize(vec3(0.5, 0.35, -0.8));
      float sd = max(dot(d, sunDir), 0.0);
      col += vec3(1.0,0.9,0.7) * pow(sd, 220.0) * 2.0;          // disc
      col += vec3(1.0,0.85,0.6) * pow(sd, 6.0) * 0.35;          // halo
      float cl = fbm(vec2(az*2.0 + uTime*0.05, h*4.0));
      col = mix(col, vec3(1.0), smoothstep(0.55, 0.85, cl) * smoothstep(0.1,0.5,h) * 0.5);
    } else if(uStyle == 3 || uStyle == 6){
      // Soft daylight + clouds (forest / pirate).
      float cl = fbm(vec2(az*2.5 + uTime*0.04, h*4.0));
      col = mix(col, vec3(1.0), smoothstep(0.5, 0.8, cl) * smoothstep(0.05,0.4,h) * 0.55);
    } else if(uStyle == 5){
      // Mech: dark tech gradient + faint scan glow.
      col += uTrim * 0.05 * (0.5 + 0.5*sin(h*40.0 - uTime));
    }

    gl_FragColor = vec4(col, 1.0);
  }
`;

export interface SkyDome {
  mesh: THREE.Mesh;
  tick: (dt: number) => void;
}

export function makeSkyDome(scene: THREE.Scene, family: FamilyDef): SkyDome {
  const t = family.theme;
  const mat = new THREE.ShaderMaterial({
    vertexShader: vert,
    fragmentShader: frag,
    side: THREE.BackSide,
    depthWrite: false,
    fog: false,
    uniforms: {
      uTime: { value: 0 },
      uStyle: { value: STYLE_IDX[family.style] ?? 7 },
      uTop: { value: new THREE.Color(t.skyTop) },
      uBot: { value: new THREE.Color(t.skyBot) },
      uTrim: { value: new THREE.Color(t.trim) },
    },
  });
  const mesh = new THREE.Mesh(new THREE.SphereGeometry(400, 32, 20), mat);
  mesh.renderOrder = -1;
  scene.add(mesh);
  return {
    mesh,
    tick(dt: number) {
      mat.uniforms.uTime.value += dt;
    },
  };
}

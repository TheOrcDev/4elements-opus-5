import * as THREE from 'three';
import { NOISE } from '../glsl/noise.js';

/**
 * FIRE — a true volumetric raymarch.
 *
 * The mesh is only a bounding sphere; the flame itself is integrated inside the
 * fragment shader. Each pixel solves ray/sphere intersection analytically, then
 * walks the segment accumulating emission and absorption through a domain-
 * warped fbm shaped into a teardrop. Layered sprite billboards can't hold up
 * when you orbit them — this holds up from every angle.
 */

// Kept low on purpose. Embers are additive sprites; pack them densely around
// the wick and they integrate into a solid white column that swallows the
// flame behind it.
const EMBER_COUNT = 900;

const flameVert = /* glsl */ `
varying vec3 vWorld;
void main() {
  vec4 wp = modelMatrix * vec4(position, 1.0);
  vWorld = wp.xyz;
  gl_Position = projectionMatrix * viewMatrix * wp;
}
`;

const flameFrag = /* glsl */ `
precision highp float;

uniform float uTime;
uniform vec3  uCenter;
uniform float uRadius;
uniform float uIntensity;
uniform float uFlicker;

varying vec3 vWorld;

${NOISE}

// Blackbody-ish ramp: ember red -> orange -> gold -> white core.
// The pale end is deliberately squeezed into the top 10% — let white start
// earlier and the whole flame desaturates into a grey-white smear.
vec3 fireRamp(float t) {
  t = clamp(t, 0.0, 1.0);
  vec3 c = mix(vec3(0.20, 0.006, 0.0), vec3(0.95, 0.115, 0.008), smoothstep(0.0, 0.30, t));
  c = mix(c, vec3(1.0, 0.34, 0.020), smoothstep(0.28, 0.58, t));
  c = mix(c, vec3(1.0, 0.66, 0.100), smoothstep(0.58, 0.86, t));
  c = mix(c, vec3(1.0, 0.93, 0.640), smoothstep(0.91, 1.0, t));
  return c;
}

// Density of the flame body at a point inside the unit bounding sphere.
// Returns density in .x and the normalised height in .y (reused for colour).
//
// The flame is defined in a space 1/FIT larger than the bounding sphere, so the
// body only ever occupies the middle of the volume. Let it reach the sphere
// wall and the silhouette gets sliced flat where the marched segment runs out.
#define FIT 0.70

// Turbulence — |noise| summed over octaves — rather than plain fbm. The folds
// at each octave's zero crossings are exactly the wispy, torn structure fire
// has; smooth fbm gives you a rolling cloud instead. Each octave scrolls upward
// faster than the last, so fine detail races through the coarse silhouette.
float fireTurb(vec3 p, float t) {
  float f = 0.0;
  float a = 0.5;
  for (int i = 0; i < 4; i++) {
    vec3 q = p;
    q.y -= t * (0.95 + float(i) * 0.62);
    f += a * abs(snoise(q));
    p *= 2.12;
    a *= 0.5;
  }
  // |snoise| averages ~0.24, so four weighted octaves land around 0.23. Scale
  // it back to roughly 0..1 with a mean near 0.5 — every consumer below reads
  // it as a normalised field, and skipping this quietly halves the density.
  return clamp(f * 2.1, 0.0, 1.0);
}

// Returns density in .x, normalised height in .y, turbulence in .z.
vec3 flame(vec3 raw, float t) {
  vec3 p = raw / FIT;
  float h = clamp((p.y + 0.94) / 1.86, 0.0, 1.0);

  // Teardrop: pinched at the wick, bulging at the shoulder, tapering to a tip.
  // A flame is far taller than it is wide — let the radius creep past ~0.35 of
  // the half-height and it reads as a bonfire puddle rather than a flame.
  float taper = pow(1.0 - h, 0.55);
  float foot  = smoothstep(0.0, 0.16, h);
  float radius = 0.36 * taper * (0.30 + 0.86 * foot);

  vec3 q = p * vec3(2.30, 1.15, 2.30);
  q.xz *= rot2(p.y * 0.70 + t * 0.25);
  float turb = fireTurb(q, t);

  // Centre the turbulence so it both eats gaps into the body and throws
  // tongues out past it, biting harder toward the tip.
  float bite = (turb - 0.50) * (0.18 + 0.55 * h);

  float d = length(p.xz) - radius + bite;
  float dens = (1.0 - smoothstep(-0.05, 0.15, d));

  // Same turbulence modulates the interior, so the body is never a solid slug.
  dens *= 0.45 + 0.85 * turb;

  dens *= (1.0 - smoothstep(0.55, 1.0, h));          // dissolve at the tip
  dens *= smoothstep(-0.97, -0.82, p.y);     // soften the base
  dens *= (1.0 - smoothstep(0.82, 1.0, length(raw))); // never touch the sphere wall
  dens *= 0.72 + 0.28 * uFlicker;

  return vec3(clamp(dens, 0.0, 1.0), h, turb);
}

void main() {
  vec3 ro = cameraPosition;
  vec3 rd = normalize(vWorld - ro);

  vec3 oc = ro - uCenter;
  float b = dot(oc, rd);
  float c = dot(oc, oc) - uRadius * uRadius;
  float disc = b * b - c;
  if (disc < 0.0) discard;

  float sq = sqrt(disc);
  float tN = max(-b - sq, 0.0);
  float tF = -b + sq;
  if (tF <= tN) discard;

  const int STEPS = 38;
  float dt = (tF - tN) / float(STEPS);

  // Dither the entry point to trade banding for a little grain.
  float jitter = fract(sin(dot(gl_FragCoord.xy, vec2(12.9898, 78.233))) * 43758.5453);
  float t = tN + dt * jitter;

  vec3 acc = vec3(0.0);
  float transmittance = 1.0;

  for (int i = 0; i < STEPS; i++) {
    if (transmittance < 0.012) break;

    vec3 p = (ro + rd * t - uCenter) / uRadius;
    vec3 f = flame(p, uTime);
    float dens = f.x;

    if (dens > 0.004) {
      // Hot only where the flame is genuinely thick, and cooling as it climbs.
      // The exponent matters: a linear ramp puts most of the volume at the
      // white end, which is what turns a flame into a light bulb. Folding the
      // turbulence in again gives hot cores inside cooler tongues.
      float temp = pow(dens, 1.5) * (1.02 - 0.62 * f.y) * (0.58 + 0.80 * f.z);
      temp = clamp(temp, 0.0, 1.0);

      // Emission stays modest and absorption runs high: an optically thick
      // flame keeps its silhouette and internal tongues instead of
      // integrating into one white blob.
      vec3 emit = fireRamp(temp) * (0.14 + 1.30 * temp * temp);
      acc += emit * dens * dt * transmittance * 5.5;
      transmittance *= exp(-dens * dt * 9.5);
    }

    t += dt;
  }

  acc *= uIntensity;

  float alpha = clamp(1.0 - transmittance, 0.0, 1.0);
  if (alpha < 0.002) discard;

  gl_FragColor = vec4(acc, alpha);
}
`;

const emberVert = /* glsl */ `
uniform float uTime;
uniform float uPixelRatio;

attribute vec3 aSeed;    // spawn offset around the wick
attribute float aPhase;  // life offset so embers don't pulse in lockstep
attribute float aSpeed;

varying float vLife;
varying float vHeat;

void main() {
  float life = fract(aPhase + uTime * aSpeed * 0.16);
  vLife = life;

  float rise = life * 3.8;

  // Wander widens as the ember cools and loses the plume.
  float wander = 0.22 + life * 1.05;
  vec3 p = aSeed;
  p.y += rise;
  p.x += sin(uTime * 1.4 * aSpeed + aPhase * 41.0 + rise * 1.3) * wander * 0.52;
  p.z += cos(uTime * 1.2 * aSpeed + aPhase * 27.0 + rise * 1.1) * wander * 0.52;

  vHeat = 1.0 - smoothstep(0.0, 0.75, life);

  vec4 mv = modelViewMatrix * vec4(p, 1.0);
  gl_Position = projectionMatrix * mv;
  gl_PointSize = (1.7 + 3.8 * vHeat) * uPixelRatio * (12.0 / -mv.z);
}
`;

const emberFrag = /* glsl */ `
precision highp float;
varying float vLife;
varying float vHeat;

void main() {
  vec2 uv = gl_PointCoord - 0.5;
  float d = length(uv);
  if (d > 0.5) discard;

  float core = (1.0 - smoothstep(0.0, 0.5, d));
  float glow = pow(core, 3.0);

  vec3 col = mix(vec3(1.0, 0.22, 0.03), vec3(1.0, 0.92, 0.62), vHeat * vHeat);
  float fade = smoothstep(0.0, 0.08, vLife) * (1.0 - smoothstep(0.55, 1.0, vLife));

  gl_FragColor = vec4(col * (0.30 + 1.1 * glow), core * fade * (0.035 + 0.22 * vHeat));
}
`;

export function createFire({ radius = 1.55 } = {}) {
  const group = new THREE.Group();

  // ---- volumetric body -------------------------------------------------
  const uniforms = {
    uTime: { value: 0 },
    uCenter: { value: new THREE.Vector3() },
    uRadius: { value: radius },
    uIntensity: { value: 1.0 },
    uFlicker: { value: 1.0 },
  };

  const bodyMat = new THREE.ShaderMaterial({
    uniforms,
    vertexShader: flameVert,
    fragmentShader: flameFrag,
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    side: THREE.FrontSide,
  });

  const body = new THREE.Mesh(new THREE.SphereGeometry(radius, 24, 18), bodyMat);
  body.frustumCulled = false;
  group.add(body);

  // ---- embers ----------------------------------------------------------
  const eg = new THREE.BufferGeometry();
  const seeds = new Float32Array(EMBER_COUNT * 3);
  const phases = new Float32Array(EMBER_COUNT);
  const speeds = new Float32Array(EMBER_COUNT);

  for (let i = 0; i < EMBER_COUNT; i++) {
    const a = Math.random() * Math.PI * 2;
    const r = Math.sqrt(Math.random()) * 0.34;
    seeds[i * 3 + 0] = Math.cos(a) * r;
    seeds[i * 3 + 1] = -radius * 0.55 + Math.random() * 0.7;
    seeds[i * 3 + 2] = Math.sin(a) * r;
    phases[i] = Math.random();
    speeds[i] = 0.65 + Math.random() * 0.85;
  }

  eg.setAttribute('position', new THREE.BufferAttribute(seeds.slice(), 3));
  eg.setAttribute('aSeed', new THREE.BufferAttribute(seeds, 3));
  eg.setAttribute('aPhase', new THREE.BufferAttribute(phases, 1));
  eg.setAttribute('aSpeed', new THREE.BufferAttribute(speeds, 1));

  const emberMat = new THREE.ShaderMaterial({
    uniforms: {
      uTime: { value: 0 },
      uPixelRatio: { value: Math.min(window.devicePixelRatio, 2) },
    },
    vertexShader: emberVert,
    fragmentShader: emberFrag,
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
  });

  const embers = new THREE.Points(eg, emberMat);
  embers.frustumCulled = false;
  group.add(embers);

  const worldPos = new THREE.Vector3();

  return {
    name: 'fire',
    group,
    radius,
    color: new THREE.Color(0xff6a1f),
    hitRadius: radius * 1.05,

    update(t, dt, camera) {
      // Two detuned oscillators plus noise read as an unpredictable flicker.
      const flick =
        0.72 +
        0.16 * Math.sin(t * 11.3) +
        0.1 * Math.sin(t * 27.7 + 1.3) +
        0.08 * Math.sin(t * 4.1 + 0.7);

      uniforms.uTime.value = t;
      uniforms.uFlicker.value = flick;
      emberMat.uniforms.uTime.value = t;

      body.getWorldPosition(worldPos);
      uniforms.uCenter.value.copy(worldPos);

      // Flip the bounding sphere inside-out if the camera enters it, so the
      // flame never pops out of existence up close.
      const inside = camera.position.distanceTo(worldPos) < radius * 1.06;
      const wanted = inside ? THREE.BackSide : THREE.FrontSide;
      if (bodyMat.side !== wanted) {
        bodyMat.side = wanted;
        bodyMat.needsUpdate = true;
      }
    },

    setPixelRatio(pr) {
      emberMat.uniforms.uPixelRatio.value = pr;
    },

    particleCount: EMBER_COUNT,
  };
}

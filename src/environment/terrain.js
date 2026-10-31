// Terrain: a hydraulically eroded heightfield landscape with slope/height/moisture shading — meadow,
// scrub, bare soil, scree, gravel channels, triplanar stratified rock on steep faces, a rippled
// sparkling sand beach with an animated wet swash band, and a tinted sea bed. One mesh, one draw;
// the map runs out into a coarse apron to the horizon so no edge ever shows.
//
//   import { createTerrain } from './environment/terrain.js'
//   const terrain = createTerrain({ preset: 'island', seed: 3 })
//   scene.add(terrain.mesh); excludeFromFraming(terrain.mesh)           // kit/edit3d.js
//   house.position.y = terrain.heightAt(x, z)                            // CPU placement
//   asset.registerAnimation('shore', { name: 'Shore', duration: 30, sample: (t) => terrain.update(t) })
//
// Options (all optional): preset 'island' (eroded volcanic island, beaches in the coves) | 'coast'
//   (mainland coast: 15–55 m sea cliffs on the headlands, wave-cut rock platform, sea stacks,
//   sandy coves) | 'hills' (rolling eroded meadow hills, no water) | 'valley' (crag-walled valley
//   with a river at sea level). size: map width m (island 1400, others 800; 300–3000).
//   resolution: grid samples per side (512; 256–768: mesh, fields, masks). erosionResolution
//   (resolution/2), erosion 0..1 strength (1), erosionIterations (130), seed (int), seaLevel (0,
//   world y of the water), heightScale (1; 0.3–2 relief multiplier), apron m beyond the map (2500),
//   swash (true on sea presets: animated wet band), grassCover (false; true darkens turf under a
//   grass layer), name, pads: level building sites [{x, z, radius} | {x, z, width, depth, angle (rad)},
//   optional y (world m; default the mean ground there) and blend (m ring, 12)]: flattened after erosion,
//   so heightAt/heightTexture/masks/mesh agree; no grass/trees/boulders on a pad, it shades as compacted
//   soil. Resolved pads (with y) are returned as terrain.pads.
// Returned: mesh, material, heightAt(x,z), normalAt(x,z), slopeAt(x,z) (rise/run), shoreAt(x,z)
//   (signed m to the waterline, + inland), grassAt/treeAt/palmAt/sandAt/rockAt/boulderAt(x,z) 0..1,
//   scatter({count,mask,minSpacing,seed}), heightTexture (RGBA HalfFloat: R world y, G shore
//   distance, B slope, A grass density) + bounds {minX,minZ,maxX,maxZ}, grassMask/treeMask/sandMask
//   (R8 DataTextures, same bounds), seaLevel, shoreGLSL, update(time) (swash + caustics; cheap),
//   setSun(dirTowardSun) (else follows the scene's first DirectionalLight), setMeadowColor(color),
//   timings, dispose(keepMaterial). Rebuilding (new seed/preset)? pass material: old.material, then
//   old.dispose(true): one stable material object (editors that track materials need that).
// Cost: 1 draw (+1 shadow), ~600k triangles at 512 (the apron adds ~30k); build ~0.6–1.0 s on an
//   M-series Mac (synthesis ~0.1, erosion ~0.35, fields/mesh ~0.2); update(time) ~0 ms; terrain sun
//   shadow re-bake ~10 ms only when the sun moves. Keep the mesh at the origin, unrotated.
// Ported from Kimi's world-building template (WebGPU/TSL) to WebGL for Edit3D.
import * as THREE from 'three'

// ---------------------------------------------------------------------------------------------
// small utilities
const smooth = (a, b, x) => { let t = (x - a) / (b - a); t = t < 0 ? 0 : t > 1 ? 1 : t; return t * t * (3 - 2 * t) }
const clamp = (x, a, b) => (x < a ? a : x > b ? b : x)
function mulberry32(seed) {
  let a = seed >>> 0
  return () => { a = (a + 0x6d2b79f5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296 }
}
function hash2(ix, iz, s) {
  let h = (Math.imul(ix, 374761393) + Math.imul(iz, 668265263) + s) | 0
  h = Math.imul(h ^ (h >>> 13), 1274126177)
  h = Math.imul(h ^ (h >>> 16), 2246822519)
  return (h ^ (h >>> 13)) >>> 0
}
const GX = new Float32Array(32), GZ = new Float32Array(32)
for (let k = 0; k < 32; k++) { GX[k] = Math.cos((k + 0.37) / 32 * Math.PI * 2); GZ[k] = Math.sin((k + 0.37) / 32 * Math.PI * 2) }
// One unbounded octave of gradient noise, remapped to ~0..1 like the template's makeOctave (whose
// value-noise lattice prints squares and grid-aligned creases once it is ridged; gradient noise does
// not), and without the wrap, so the same field continues into the apron. `LOD` > 0 fades octaves
// finer than ~2 vertex spacings back to their mean, so the coarse apron does not alias.
let LOD = 0
// the template's own value-noise octave (random lattice values, smoothstep interpolation): the island
// massif is built from it, and ridged *gradient* noise — zero at every lattice point — would turn
// that massif into a field of parallel streaks
function makeValueOctave(wavelength, seed) {
  const inv = 1 / wavelength
  return (x, z) => {
    const X = x * inv, Z = z * inv, ix = Math.floor(X), iz = Math.floor(Z)
    let fx = X - ix, fz = Z - iz
    fx = fx * fx * (3 - 2 * fx); fz = fz * fz * (3 - 2 * fz)
    const a = hash2(ix, iz, seed) / 4294967296, b = hash2(ix + 1, iz, seed) / 4294967296, c = hash2(ix, iz + 1, seed) / 4294967296, d = hash2(ix + 1, iz + 1, seed) / 4294967296
    const ab = a + (b - a) * fx, v = ab + (c + (d - c) * fx - ab) * fz
    if (LOD === 0) return v
    return 0.5 + (v - 0.5) * clamp((wavelength / LOD - 1.5) / 1.5, 0, 1)
  }
}
function makeOctave(wavelength, seed) {
  const inv = 1 / wavelength
  return (x, z) => {
    const X = x * inv, Z = z * inv, ix = Math.floor(X), iz = Math.floor(Z), fx = X - ix, fz = Z - iz
    const h00 = hash2(ix, iz, seed) & 31, h10 = hash2(ix + 1, iz, seed) & 31, h01 = hash2(ix, iz + 1, seed) & 31, h11 = hash2(ix + 1, iz + 1, seed) & 31
    const a = GX[h00] * fx + GZ[h00] * fz, b = GX[h10] * (fx - 1) + GZ[h10] * fz
    const c = GX[h01] * fx + GZ[h01] * (fz - 1), d = GX[h11] * (fx - 1) + GZ[h11] * (fz - 1)
    const u = fx * fx * fx * (fx * (fx * 6 - 15) + 10), v = fz * fz * fz * (fz * (fz * 6 - 15) + 10)
    const n = a + (b - a) * u + (c - a + (a - b - c + d) * u) * v
    if (LOD === 0) return 0.5 + n * 0.95
    return 0.5 + n * 0.95 * clamp((wavelength / LOD - 1.5) / 1.5, 0, 1)
  }
}
const ridged = (v) => { const n = 1 - Math.abs(2 * v - 1); return n * n }
// ridged with a rounded crest (k sets the crest radius): eroded volcanic ridges, not knife edges
const RK = 0.4, RC = 1 + RK - Math.sqrt(1 + RK * RK)
const ridgedSoft = (v) => { const a = 2 * v - 1, n = (1 + RK - Math.sqrt(a * a + RK * RK) - RC) / (1 - RC); return n * n }

// ---------------------------------------------------------------------------------------------
// The shared waterline model (world/shore.js), procedural so the ocean can run the identical code in
// its vertex stage. Everything keys on still-water depth; see the template's README "the waterline is
// shared". bedH = ground height relative to sea level, dS = signed shore distance, time = seconds.
export const SHORE_GLSL = /* glsl */`
float shoreStep(float a, float b, float x) { float t = clamp((x - a) / (b - a), 0.0, 1.0); return t * t * (3.0 - 2.0 * t); }
float shoreHash(vec2 p) { vec3 q = fract(vec3(p.xyx) * 0.1031); q += dot(q, q.yzx + 33.33); return fract((q.x + q.y) * q.z); }
float shoreNoise(vec2 p) {
  vec2 i = floor(p), f = fract(p);
  vec2 u = f * f * f * (f * (f * 6.0 - 15.0) + 10.0);
  return mix(mix(shoreHash(i), shoreHash(i + vec2(1.0, 0.0)), u.x), mix(shoreHash(i + vec2(0.0, 1.0)), shoreHash(i + vec2(1.0, 1.0)), u.x), u.y);
}
float shoreField(vec2 p) { return 0.5 + (shoreNoise(p) * 0.67 + shoreNoise(p * 2.03 + 17.1) * 0.33 - 0.5) * 0.85; }
vec4 shoreSample(vec2 xz, float bedH, float dS, float time) {
  float dd = max(-bedH, 0.0);
  float shoreNear = shoreStep(45.0, 3.0, dS);
  float nW = shoreField(xz / 48.0);
  float nZ = shoreField(xz / 12.0 + 31.7);
  float dr = time * 0.55;
  vec2 q = vec2(xz.x + dr, xz.y - dr * 0.62);
  float tW = shoreField(q / 21.5 + 7.3);
  float tZ = shoreField(q / 5.4 + 53.1);
  float mag = exp(-dd / 1.45);
  float p = dd * 3.1 + time * 1.30 + (nW - 0.5) * 0.9 + (tW - 0.5) * 0.75;
  float sw = sin(p + cos(p) * (1.0 - mag)) * -0.5 + 0.5;
  float shape = pow(clamp(mix(tZ, nZ, 0.32), 0.0, 1.0), 1.35);
  float shorePatch = mix(0.24, 1.28, shape);
  float swing = sqrt(mag) * shorePatch * shoreNear * 0.36;
  float envelope = swing * (1.0 - 0.30);
  float level = (sw - shoreStep(0.22, 0.0, dd) * 0.30) * swing;
  float trail = (sin(p - 3.14159265 * 0.85) * 0.5 + 0.5) * mag * shorePatch * shoreNear;
  float fray = (shoreNoise(vec2(xz.x - dr * 1.4, xz.y + dr * 0.4) / 1.75) - 0.5) * 0.075 * shoreNear;
  return vec4(level, trail, envelope, fray);
}
float shoreLip(float dh) {
  float e = clamp(1.0 - (dh + 0.02) * 5.0, 0.0, 1.0);
  return sqrt(max(1.0 - e * e, 0.0)) * shoreStep(0.55, 0.12, dh) * shoreStep(-0.07, 0.015, dh) * 0.085;
}
float shoreFoam(float trail, float dh) {
  float dry = shoreStep(-0.045, 0.012, dh);
  float edge = dry * shoreStep(0.13, 0.03, dh);
  return clamp(max(trail * shoreStep(0.45, 0.03, dh) * dry * 0.55, edge), 0.0, 1.0);
}
`

// ---------------------------------------------------------------------------------------------
// Detail tile (world/sand.js makeSandDetail): periodic Perlin with analytic derivatives. R,G = dh/du,
// dh/dv of a 1/f relief fbm (flat slope spectrum, so the mip chain flattens it the way distance
// flattens sand), B = the relief itself, A = a broad decorrelated fbm. 256² RGBA8 here (the original
// is 512² RGBA16F); the beach, the rock, the meadow and the rocks all read it. Built once, shared.
let detailTex = null
export function getDetailTexture() {
  if (detailTex) return detailTex
  const D = 256, N = D * D, raw = new Float32Array(N * 4), rand = mulberry32(90210), out = [0, 0, 0]
  const perlin = (lattice) => {
    const gx = new Float32Array(lattice * lattice), gy = new Float32Array(lattice * lattice)
    for (let i = 0; i < gx.length; i++) { const a = rand() * Math.PI * 2; gx[i] = Math.cos(a); gy[i] = Math.sin(a) }
    return (u, v) => {
      const X = u * lattice, Y = v * lattice, ix = Math.floor(X), iy = Math.floor(Y), fx = X - ix, fy = Y - iy
      const x0 = ix % lattice, y0 = iy % lattice, x1 = (x0 + 1) % lattice, y1 = (y0 + 1) % lattice
      const i00 = y0 * lattice + x0, i10 = y0 * lattice + x1, i01 = y1 * lattice + x0, i11 = y1 * lattice + x1
      const a = gx[i00] * fx + gy[i00] * fy, b = gx[i10] * (fx - 1) + gy[i10] * fy
      const c = gx[i01] * fx + gy[i01] * (fy - 1), d = gx[i11] * (fx - 1) + gy[i11] * (fy - 1)
      const su = fx * fx * fx * (fx * (fx * 6 - 15) + 10), sv = fy * fy * fy * (fy * (fy * 6 - 15) + 10)
      const du = 30 * fx * fx * (fx * (fx - 2) + 1), dv = 30 * fy * fy * (fy * (fy - 2) + 1)
      const nx0 = a + su * (b - a), nx1 = c + su * (d - c)
      const dx0 = gx[i00] + su * (gx[i10] - gx[i00]) + du * (b - a), dx1 = gx[i01] + su * (gx[i11] - gx[i01]) + du * (d - c)
      const dy0 = gy[i00] + su * (gy[i10] - gy[i00]), dy1 = gy[i01] + su * (gy[i11] - gy[i01])
      out[0] = nx0 + sv * (nx1 - nx0)
      out[1] = (dx0 + sv * (dx1 - dx0)) * lattice
      out[2] = (dy0 + sv * (dy1 - dy0) + dv * (nx1 - nx0)) * lattice
    }
  }
  const acc = (lattices, write) => {
    for (const lattice of lattices) {
      const oct = perlin(lattice), amp = 1 / lattice
      for (let y = 0; y < D; y++) for (let x = 0; x < D; x++) { oct(x / D, y / D); write((y * D + x) * 4, amp) }
    }
  }
  acc([8, 16, 32, 64], (i, amp) => { raw[i] += out[1] * amp; raw[i + 1] += out[2] * amp; raw[i + 2] += out[0] * amp })
  acc([2, 4, 8, 16], (i, amp) => { raw[i + 3] += out[0] * amp })
  let s2 = 0, hMin = Infinity, hMax = -Infinity, pMin = Infinity, pMax = -Infinity
  for (let i = 0; i < N; i++) {
    const k = i * 4; s2 += raw[k] * raw[k] + raw[k + 1] * raw[k + 1]
    hMin = Math.min(hMin, raw[k + 2]); hMax = Math.max(hMax, raw[k + 2]); pMin = Math.min(pMin, raw[k + 3]); pMax = Math.max(pMax, raw[k + 3])
  }
  const dS = 1 / (3 * Math.sqrt(s2 / (2 * N))), data = new Uint8Array(N * 4)
  for (let i = 0; i < N; i++) {
    const k = i * 4
    data[k] = Math.round((clamp(raw[k] * dS, -1, 1) * 0.5 + 0.5) * 255)
    data[k + 1] = Math.round((clamp(raw[k + 1] * dS, -1, 1) * 0.5 + 0.5) * 255)
    data[k + 2] = Math.round(((raw[k + 2] - hMin) / (hMax - hMin)) * 255)
    data[k + 3] = Math.round(((raw[k + 3] - pMin) / (pMax - pMin)) * 255)
  }
  const t = new THREE.DataTexture(data, D, D, THREE.RGBAFormat, THREE.UnsignedByteType)
  t.wrapS = t.wrapT = THREE.RepeatWrapping
  t.magFilter = THREE.LinearFilter; t.minFilter = THREE.LinearMipmapLinearFilter
  t.generateMipmaps = true; t.anisotropy = 8; t.name = 'terrain-detail'; t.needsUpdate = true
  detailTex = t
  return t
}

// ---------------------------------------------------------------------------------------------
// Presets. Each returns macro(x, z, out) -> out = [height (m above sea), coast distance cD (m, +
// inland; huge when there is no sea), bay (0..1, where sand collects), bedrock hardness (0..1), bare
// rock flag (0..1)], plus pointwise post(x, z, h) after erosion, and look constants.
const PRESETS = {
  island: { size: 1400, sea: true, swash: true },
  coast: { size: 800, sea: true, swash: true },
  hills: { size: 800, sea: false, swash: false },
  valley: { size: 800, sea: true, swash: false },
}

// world/island.js stage 1, scaled by S = size / 2200 (the original map). Proportional features
// (lobes, massifs, hills) scale with the island; metric ones (shelf, bar, beach ramp, blend) do not —
// they read the coast field through cD = cS·S·700 m, which is roughly metres from the waterline.
function islandPreset(o, O) {
  const L = o.size, S = L / 2200, hs = o.heightScale, wl = (n) => L / n
  const w1x = O(wl(3)), w1z = O(wl(3)), w2x = O(wl(9)), w2z = O(wl(9)), w3x = O(wl(27)), w3z = O(wl(27))
  const c1 = O(wl(4)), c2 = O(wl(7)), c3 = O(wl(13)), c4 = O(wl(26))
  const h1 = O(wl(8)), h2 = O(wl(16)), h3 = O(wl(33)), h4 = O(wl(67))
  const r1 = O(1 / 5), r2 = O(1 / 11), r3 = O(1 / 23), r4 = O(1 / 47)
  const k1 = O(wl(9)), k2 = O(wl(23)), b1 = O(wl(21))
  const ca0 = Math.cos(-0.55), sa0 = Math.sin(-0.55), car = Math.cos(0.62), sar = Math.sin(0.62)
  const peaks = [
    { x: 330 * S, z: -140 * S, r: 720 * S, core: 120 * S, p: 1.25, h: 255 * S * hs, dome: 120 * S * hs },
    { x: -80 * S, z: 300 * S, r: 480 * S, core: 90 * S, p: 1.5, h: 130 * S * hs, dome: 55 * S * hs },
  ]
  const half = L / 2, seaFloor = -22
  return {
    sandTop: 3.3, treeLine: 190 * S * hs, seaFloor, rampRate: 9 / 700, depoTop: 17,
    macro(x, z, out) {
      const px = x + (w1x(x, z) - 0.5) * 400 * S + (w2x(x, z) - 0.5) * 300 * S + (w3x(x, z) - 0.5) * 130 * S
      const pz = z + (w1z(x, z) - 0.5) * 400 * S + (w2z(x, z) - 0.5) * 300 * S + (w3z(x, z) - 0.5) * 130 * S
      const ex = (px * ca0 - pz * sa0) / (860 * S), ez = (px * sa0 + pz * ca0) / (590 * S)
      const c1v = c1(x, z), c2v = c2(x, z), h4v = h4(x, z)
      let c = 1 - Math.hypot(ex, ez) + (0.40 * c1v + 0.26 * c2v + 0.20 * c3(x, z) + 0.14 * c4(x, z) - 0.5) * 0.78
      c -= smooth(0.70, 0.97, Math.max(Math.abs(x), Math.abs(z)) / half) * 0.7 // the map border is open sea
      const cS = c - 0.18, cD = cS * S * 700
      const bayK = smooth(0.53, 0.33, 0.62 * c1v + 0.38 * c2v)
      const shelf = -1.5 + cD * (145 - 88 * bayK) / 700
      const barT = (cD + 36.4) / 21
      const bar = 2.2 * bayK * Math.exp(-barT * barT) * smooth(0.30, 0.62, b1(x, z))
      const hSea = Math.max(seaFloor, shelf + bar)
      const inland = smooth(0.0, 0.14, cS)
      const h01 = 0.52 * h1(x, z) + 0.27 * h2(x, z) + 0.14 * h3(x, z) + 0.07 * h4v
      const hn = 1 - Math.pow(1 - clamp(h01, 0, 1), 1.7)
      const hills = 46 * S * hs * hn * (0.35 + 0.65 * inland)
      const ru = (x * car + z * sar) / L * 0.75 + 0.31, rv = (-x * sar + z * car) / L * 2.4 + 0.77
      let ridgeH = 0, ridgePow = -1
      for (let k = 0; k < 2; k++) {
        const pk = peaks[k], zone = Math.pow(smooth(pk.r, pk.core, Math.hypot(px - pk.x, pz - pk.z)), pk.p)
        if (zone <= 0.003) continue
        // broad octaves get rounded crests, the fine ones are damped: domes and shouldered ridges (the
        // original's GPU erosion at 2 m does this rounding; at our coarser erosion grid it must be built in)
        if (ridgePow < 0) ridgePow = Math.pow(0.58 * ridgedSoft(r1(ru, rv)) + 0.32 * ridgedSoft(r2(ru, rv)) + 0.07 * ridgedSoft(r3(ru, rv)) + 0.03 * ridged(r4(ru, rv)), 1.35)
        ridgeH = Math.max(ridgeH, zone * (ridgePow * pk.h + zone * pk.dome))
      }
      const hLand = 2.3 + 4.5 * inland + hills + ridgeH * inland + (h4v - 0.5) * 2.4 * (0.3 + 0.7 * inland)
      const h = Math.max(hSea + (hLand - hSea) * smooth(-12.6, 29.4, cD), seaFloor)
      out[0] = h; out[1] = cD; out[2] = bayK
      out[3] = clamp(0.10 + 0.66 * smooth(40 * S * hs, 210 * S * hs, h) + 0.3 * (0.6 * k1(x, z) + 0.4 * k2(x, z)) - 0.15 + smooth(2.0, -3.0, h), 0.05, 1)
      out[4] = 0
    },
  }
}

// A mainland coast running along x with the sea toward +z. Headlands (where the coastline juts out)
// are hard rock: a plateau ending in a 15–55 m cliff, a near-vertical face with a rounded crest and a
// talus apron, buttresses and gullies running down it, a rough wave-cut platform at its foot and the
// odd sea stack offshore. The coves between them are soft and catch sand. Inland it rolls up to a
// ridge so the far edge of the map is a skyline, not a cut.
function coastPreset(o, O, rand) {
  const L = o.size, hs = o.heightScale
  const cl1 = O(L * 0.5), cl2 = O(L * 0.2), cl3 = O(L * 0.07), cl4 = O(23)
  const wx = O(150), wz = O(150), wx2 = O(41), wz2 = O(41)
  const hc1 = O(L * 0.45), hc2 = O(110), rib1 = O(21), rib2 = O(8.5), reef1 = O(13), reef2 = O(4.7)
  const h1 = O(L * 0.38), h2 = O(L * 0.17), h3 = O(L * 0.08), h4 = O(31)
  const g1 = O(L * 0.33), g2 = O(L * 0.14), k1 = O(70), b1 = O(105), wb = O(170)
  const ra = O(95), by1 = O(64), by2 = O(29), slN = O(140), cw = O(57), tc1 = O(45), tc2 = O(17)
  const z0 = L * 0.04
  const coastZ = (px) => z0 + (cl1(px, 0) - 0.5) * L * 0.5 + (cl2(px, 31.7) - 0.5) * L * 0.16 + (cl3(px, 7.1) - 0.5) * L * 0.04 + (cl4(px, 3.3) - 0.5) * 7
  const cliffH = (x, z) => Math.max(14, (36 + (hc1(x, z) - 0.5) * 44 + (hc2(x, z) - 0.5) * 16 + (tc1(x, z) - 0.5) * 12)) * hs
  const bayOf = (a, b) => smooth(0.52, 0.40, 0.62 * a + 0.38 * b)
  const cliffK = (px) => smooth(0.30, 0.70, 1 - bayOf(cl1(px, 0), cl2(px, 31.7)))
  // one to three sea stacks off the boldest headlands, 30–70 m out, never in a row
  const stacks = []
  {
    const cand = []
    for (let x = -L * 0.4; x <= L * 0.4; x += 10) { const k = cliffK(x); if (k > 0.85) cand.push({ x, k: k + rand() * 0.1 }) }
    cand.sort((p, q) => q.k - p.k)
    const want = 1 + Math.floor(rand() * 2.6)
    for (const c of cand) {
      if (stacks.length >= want) break
      if (stacks.some((s) => Math.abs(s.x - c.x) < 140)) continue
      const zc = coastZ(c.x)
      stacks.push({ x: c.x, z: zc + 30 + rand() * 40, r: 8 + rand() * 8, h: (0.5 + rand() * 0.4) * cliffH(c.x, zc - 30), ph: rand() * 6.28 })
    }
  }
  return {
    sandTop: 3.3, treeLine: 400, seaFloor: -26, rampRate: 1 / 22, depoTop: 12, stacks,
    macro(x, z, out) {
      const px = x + (wx(x, z) - 0.5) * 34 + (wx2(x, z) - 0.5) * 11
      const pz = z + (wz(x, z) - 0.5) * 34 + (wz2(x, z) - 0.5) * 11
      const d = coastZ(px) - pz // ≈ metres inland of the waterline
      // away from the waterline the cove/headland split bends and widens, so the sides of a cove
      // valley (and of its shelf offshore) do not run dead straight inland
      const far = smooth(5, 220, Math.abs(d)), bx = px + (wb(x, z) - 0.5) * 160 * far
      const bay = bayOf(cl1(bx, 0), cl2(bx, 31.7)), clS = smooth(0.30 - 0.25 * far, 0.70 + 0.25 * far, 1 - bay)
      const Hc = cliffH(x, z), W = Hc / 2.5
      // hinterland: rolling hills over the plateau, rising to a back ridge
      const hn = 1 - Math.pow(1 - clamp(0.5 * h1(x, z) + 0.28 * h2(x, z) + 0.15 * h3(x, z) + 0.07 * h4(x, z), 0, 1), 1.6)
      const back = 0.7 * ridged(g1(x, z)) + 0.3 * ridged(g2(x, z))
      const hills = (hn * 30 * smooth(20, 260, d) + back * 110 * smooth(L * 0.18, L * 0.7, d)) * hs
      // cove: a shelving sandy bottom with a longshore bar, soft ground rising behind it to the
      // same plateau the cliffs carry, so cove and headland meet inland without a wall
      const barT = (d + 42) / 15
      const bar = 1.8 * Math.exp(-barT * barT) * smooth(0.30, 0.62, b1(x, z))
      const coveSea = Math.max(-26, -0.25 + d / 30 - 4 * (d / 120) * (d / 120) + bar)
      const coveLand = 0.9 + d * 0.06 + (Hc - 0.9 - d * 0.06) * smooth(30, 260, d)
      const hCove = coveSea + (coveLand - coveSea) * smooth(-8, 8, d)
      // headland: cliff profile across the coast, the edge jittered along x only, so buttresses and
      // gullies run straight down the face; a rough wave-cut platform at its foot
      // the cliff line wanders in and out (small bays, buttresses), the ribs vary in strength along
      // the coast and lean across the face, and some stretches have slumped into a two-step bench
      const ribA = 0.25 + 1.5 * smooth(0.25, 0.75, ra(x, 0.5))
      const rib = ((ridged(rib1(x + d * 0.35, 0.5)) - 0.35) * 8 + (rib2(x - d * 0.2, 0.5) - 0.5) * 3.5) * ribA
        + (by1(x, 0.5) - 0.5) * 34 + (by2(x, 0.5) - 0.5) * 12
      const t = (d - rib) / W, slump = smooth(0.56, 0.70, slN(x, 0.5))
      const crest = 1.0 + 1.6 * cw(x, z)
      let pc = 0.10 * smooth(-0.7, 0.15, t) + 0.90 * smooth(0.05, crest, t)
      pc += (0.42 * smooth(-0.6, 0.5, t) + 0.58 * smooth(1.4, 2.8 + crest, t) - pc) * slump
      // a broken, craggy top edge rather than a ruled line
      pc += (ridged(tc2(x, z)) - 0.45) * 0.10 * smooth(0.4, 1.0, t) * smooth(2.6 + crest, 1.2, t)
      const reef = (reef1(x, z) - 0.5) * 1.3 + (reef2(x, z) - 0.5) * 0.7
      const plat = -0.75 + reef + Math.min(0, d + 24) * 0.5
      const hCliff = Math.max(-26, -0.4 + (Hc + 0.4) * pc + (plat + 0.4) * (1 - smooth(-0.7 * W, 0.05 * W, d - rib)))
      const slumpSoft = slump * smooth(-0.3, 0.6, t) * smooth(3.5, 1.5, t)   // slumped ground is soil and scree, not hard face
      let h = hCove + (hCliff - hCove) * clS + hills, hard = 0
      for (let i = 0; i < stacks.length; i++) {
        const s = stacks[i], dx = x - s.x, dz = z - s.z, r = Math.hypot(dx, dz)
        if (r > s.r * 2.2) continue
        const ang = Math.atan2(dz, dx), rr = r * (1 + 0.16 * Math.sin(3 * ang + s.ph) + 0.08 * Math.sin(7 * ang - s.ph))
        const hs2 = -0.6 + (s.h + 0.6) * (0.12 * smooth(s.r * 1.9, s.r * 1.1, rr) + 0.88 * smooth(s.r, s.r * 0.55, rr))
        if (hs2 > h) h = hs2
        hard = Math.max(hard, smooth(s.r * 2, s.r, r))
      }
      out[0] = h; out[1] = d; out[2] = bay
      out[3] = clamp(Math.max(hard, 0.28 + 0.68 * clS * (1 - 0.6 * slumpSoft) * smooth(-30, -5, d) * smooth(W + 45, W + 5, d)) + 0.2 * (k1(x, z) - 0.5) + 0.45 * smooth(80 * hs, 150 * hs, h) + smooth(2.0, -3.0, h), 0.05, 1)
      out[4] = Math.max(clS * smooth(8, -2, d) * smooth(2.5, 0.5, h), hard * smooth(2.5, 0.5, h))
    },
  }
}

function hillsPreset(o, O) {
  const L = o.size, hs = o.heightScale
  const h1 = O(L * 0.5), h2 = O(L * 0.23), h3 = O(L * 0.11), h4 = O(L * 0.05), h5 = O(19)
  const r1 = O(L * 0.32), r2 = O(L * 0.14), wx = O(L * 0.35), wz = O(L * 0.35), k1 = O(80)
  return {
    sandTop: 0, treeLine: 400, seaFloor: 0, rampRate: 0, depoTop: 0,
    macro(x, z, out) {
      const px = x + (wx(x, z) - 0.5) * L * 0.18, pz = z + (wz(x, z) - 0.5) * L * 0.18
      const f = 0.5 * h1(px, pz) + 0.27 * h2(px, pz) + 0.15 * h3(x, z) + 0.08 * h4(x, z)
      const hn = 1 - Math.pow(1 - clamp((f - 0.18) / 0.66, 0, 1), 1.7)
      const crest = (0.6 * ridged(r1(px, pz)) + 0.4 * ridged(r2(x, z))) * smooth(0.40, 0.75, f)
      const h = 7 + (hn * 74 + crest * 30 + (h5(x, z) - 0.5) * 2.4) * hs
      out[0] = h; out[1] = 1e4; out[2] = 0
      out[3] = clamp(0.22 + 0.5 * smooth(55 * hs, 95 * hs, h) + 0.25 * (k1(x, z) - 0.5), 0.05, 1); out[4] = 0
    },
  }
}

// A valley along x: a meadow floor a couple of metres above a river at sea level, walls rising to
// crags. The river is carved after erosion (post), so the pipe model cannot silt it up.
function valleyPreset(o, O) {
  const L = o.size, hs = o.heightScale
  const m1 = O(L * 0.8), m2 = O(L * 0.27), v1 = O(170), v2 = O(57), fw = O(L * 0.3), fl = O(90)
  const h1 = O(L * 0.3), h2 = O(L * 0.13), h3 = O(L * 0.06), h4 = O(29), p1 = O(L * 0.22), p2 = O(L * 0.09), p3 = O(L * 0.04), k1 = O(70)
  const axis = (x) => (m1(x, 0) - 0.5) * L * 0.26 + (m2(x, 0.5) - 0.5) * L * 0.08
  const river = (x) => axis(x) + (v1(x, 0.25) - 0.5) * 80 + (v2(x, 0.75) - 0.5) * 20
  return {
    sandTop: 1.1, treeLine: 125 * hs, seaFloor: -3, rampRate: 0, depoTop: 0,
    macro(x, z, out) {
      const d = Math.abs(z - axis(x)), F = 70 + (fw(x, 0) - 0.5) * 50
      const wall = Math.pow(smooth(F, F + 290, d), 1.15) * 120
      const crag = (0.5 * ridged(p1(x, z)) + 0.32 * ridged(p2(x, z)) + 0.18 * ridged(p3(x, z))) * 95 * smooth(F + 60, F + 300, d)
      const hills = (0.5 * h1(x, z) + 0.27 * h2(x, z) + 0.15 * h3(x, z) + 0.08 * h4(x, z) - 0.5) * 26 * smooth(F * 0.6, F + 80, d)
      const h = 2.4 + (fl(x, z) - 0.5) * 1.4 + (wall + crag + hills) * hs
      out[0] = h; out[1] = Math.abs(z - river(x)) - 10; out[2] = 0
      out[3] = clamp(0.2 + 0.72 * smooth(45 * hs, 110 * hs, h) + 0.2 * (k1(x, z) - 0.5), 0.05, 1); out[4] = 0
    },
    post(x, z, h) {
      const dr = Math.abs(z - river(x)), RW = 10
      if (dr > 60) return h
      // the channel, a metre and a half deep, then low banks the meadow comes down to
      const prof = dr < RW ? -1.7 + (dr / RW) * (dr / RW) * 2.05 : 0.35 + (dr - RW) * 0.09
      return Math.min(h, prof)
    },
  }
}

// ---------------------------------------------------------------------------------------------
// Pipe-model hydraulic erosion + thermal talus (world/erosion.js), CPU typed arrays. Five fused passes
// per iteration — flux, water+velocity, dissolve/deposit, semi-Lagrangian advection, talus — with the
// original constants, run at the 2.15 m texel they were calibrated for (see the similarity scaling).
function erodeCPU(N, texel, iters, h, hard) {
  const n = N * N, DT = 0.03, RAIN = 0.012, EVAP = 0.02, KC = 0.6, KS = 0.3, KD = 0.5, G = 9.81
  const THERMAL = 0.15, MAXV = 6, MAXE = 0.06, MAXD = 0.1
  let wA = new Float32Array(n), wB = new Float32Array(n), sA = new Float32Array(n), sB = new Float32Array(n)
  const sT = new Float32Array(n), fl = new Float32Array(n), fr = new Float32Array(n), fd = new Float32Array(n), fu = new Float32Array(n)
  const vx = new Float32Array(n), vy = new Float32Array(n), hB = new Float32Array(n), depo = new Float32Array(n)
  const talus = new Float32Array(n), rate = new Float32Array(n), soft = new Float32Array(n)
  for (let i = 0; i < n; i++) { const k = hard[i]; talus[i] = 0.55 + k * k * 2.6; rate[i] = Math.pow(1 - k, 1.5) * THERMAL * DT * texel; soft[i] = 1 - k * 0.92 }
  const kf = DT * G / texel, M = N - 1, d1 = texel, d2 = texel * Math.SQRT2, sc = DT / texel, it2 = 1 / (2 * texel)
  for (let it = 0; it < iters; it++) {
    for (let y = 0; y < N; y++) { // 1 · outflow flux from hydraulic head differences
      const r = y * N, rm = (y > 0 ? y - 1 : 0) * N, rp = (y < M ? y + 1 : M) * N
      for (let x = 0; x < N; x++) {
        const i = r + x, L = r + (x > 0 ? x - 1 : 0), R = r + (x < M ? x + 1 : M), head = h[i] + wA[i]
        let a = fl[i] + (head - h[L] - wA[L]) * kf; if (a < 0) a = 0
        let b = fr[i] + (head - h[R] - wA[R]) * kf; if (b < 0) b = 0
        let c = fd[i] + (head - h[rm + x] - wA[rm + x]) * kf; if (c < 0) c = 0
        let d = fu[i] + (head - h[rp + x] - wA[rp + x]) * kf; if (d < 0) d = 0
        const tot = a + b + c + d
        let k = tot > 1e-6 ? wA[i] / (tot * DT) : 1; if (k > 1) k = 1 // never drain below empty
        fl[i] = a * k; fr[i] = b * k; fd[i] = c * k; fu[i] = d * k
      }
    }
    for (let y = 0; y < N; y++) { // 2 · water: flux divergence + rain − evaporation; velocity
      const r = y * N, rm = (y > 0 ? y - 1 : 0) * N, rp = (y < M ? y + 1 : M) * N, edgeY = y < 1 || y > N - 2
      for (let x = 0; x < N; x++) {
        const i = r + x, L = r + (x > 0 ? x - 1 : 0), R = r + (x < M ? x + 1 : M), D = rm + x, U = rp + x
        const w0 = wA[i]
        let w1 = w0 + (fr[L] + fl[R] + fu[D] + fd[U] - fl[i] - fr[i] - fd[i] - fu[i]) * DT; if (w1 < 0) w1 = 0
        wB[i] = edgeY || x < 1 || x > N - 2 ? 0 : w1 * (1 - EVAP * DT) + RAIN * DT // the map edge drains
        let wAvg = (w0 + w1) * 0.5; if (wAvg < 1e-4) wAvg = 1e-4
        let ux = (fr[L] - fl[i] + fr[i] - fl[R]) * 0.5 / (wAvg * texel), uy = (fu[D] - fd[i] + fu[i] - fd[U]) * 0.5 / (wAvg * texel)
        const sp = Math.sqrt(ux * ux + uy * uy)
        if (sp > MAXV) { const q = MAXV / sp; ux *= q; uy *= q }
        vx[i] = ux; vy[i] = uy
      }
    }
    for (let y = 0; y < N; y++) { // 3 · capacity C = Kc·sin(slope)·|v|; dissolve or deposit
      const r = y * N, rm = (y > 0 ? y - 1 : 0) * N, rp = (y < M ? y + 1 : M) * N
      for (let x = 0; x < N; x++) {
        const i = r + x
        const gx = (h[r + (x < M ? x + 1 : M)] - h[r + (x > 0 ? x - 1 : 0)]) * it2, gy = (h[rp + x] - h[rm + x]) * it2
        const sl = Math.sqrt(gx * gx + gy * gy)
        let sinA = sl / Math.sqrt(sl * sl + 1); if (sinA < 0.012) sinA = 0.012
        let sh = wB[i] * 4; if (sh > 1) sh = 1 // a millimetre of water carries nothing
        const cap = KC * sinA * Math.sqrt(vx[i] * vx[i] + vy[i] * vy[i]) * sh, s0 = sA[i]
        let cut = cap > s0 ? (cap - s0) * KS * DT * soft[i] : 0; if (cut > MAXE) cut = MAXE
        let lay = s0 > cap ? (s0 - cap) * KD * DT : 0; if (lay > MAXD) lay = MAXD
        hB[i] = h[i] + lay - cut; sT[i] = s0 + cut - lay; depo[i] += lay
      }
    }
    for (let y = 0; y < N; y++) { // 4 · carry suspended sediment along v
      for (let x = 0; x < N; x++) {
        const i = y * N + x
        let bx = x - vx[i] * sc, by = y - vy[i] * sc
        bx = bx < 0 ? 0 : bx > M ? M : bx; by = by < 0 ? 0 : by > M ? M : by
        const x0 = bx | 0, y0 = by | 0, fx = bx - x0, fy = by - y0, x1 = x0 < M ? x0 + 1 : M, y1 = y0 < M ? y0 + 1 : M
        const a = sT[y0 * N + x0], b = sT[y0 * N + x1], c = sT[y1 * N + x0], d = sT[y1 * N + x1]
        sB[i] = (a + (b - a) * fx) * (1 - fy) + (c + (d - c) * fx) * fy
      }
    }
    for (let y = 0; y < N; y++) { // 5 · talus: hard rock holds near-cliff angles, soil relaxes to ~30°
      const r = y * N, rm = (y > 0 ? y - 1 : 0) * N, rp = (y < M ? y + 1 : M) * N
      for (let x = 0; x < N; x++) {
        const i = r + x, xm = x > 0 ? x - 1 : 0, xp = x < M ? x + 1 : M, h0 = hB[i], t0 = talus[i], r0 = rate[i]
        let net = 0, j, dd
        j = r + xm; dd = (hB[j] - h0) / d1; if (dd > talus[j]) net += (dd - talus[j]) * rate[j]; else if (-dd > t0) net -= (-dd - t0) * r0
        j = r + xp; dd = (hB[j] - h0) / d1; if (dd > talus[j]) net += (dd - talus[j]) * rate[j]; else if (-dd > t0) net -= (-dd - t0) * r0
        j = rm + x; dd = (hB[j] - h0) / d1; if (dd > talus[j]) net += (dd - talus[j]) * rate[j]; else if (-dd > t0) net -= (-dd - t0) * r0
        j = rp + x; dd = (hB[j] - h0) / d1; if (dd > talus[j]) net += (dd - talus[j]) * rate[j]; else if (-dd > t0) net -= (-dd - t0) * r0
        j = rm + xm; dd = (hB[j] - h0) / d2; if (dd > talus[j]) net += (dd - talus[j]) * rate[j]; else if (-dd > t0) net -= (-dd - t0) * r0
        j = rp + xp; dd = (hB[j] - h0) / d2; if (dd > talus[j]) net += (dd - talus[j]) * rate[j]; else if (-dd > t0) net -= (-dd - t0) * r0
        j = rp + xm; dd = (hB[j] - h0) / d2; if (dd > talus[j]) net += (dd - talus[j]) * rate[j]; else if (-dd > t0) net -= (-dd - t0) * r0
        j = rm + xp; dd = (hB[j] - h0) / d2; if (dd > talus[j]) net += (dd - talus[j]) * rate[j]; else if (-dd > t0) net -= (-dd - t0) * r0
        h[i] = h0 + (net > 0.22 ? 0.22 : net < -0.22 ? -0.22 : net)
      }
    }
    let t = wA; wA = wB; wB = t; t = sA; sA = sB; sB = t
  }
  return { height: h, water: wA, sediment: depo }
}

// ---------------------------------------------------------------------------------------------
// GLSL shared by the terrain and the rocks
const lin = (r, g, b) => { const c = new THREE.Color().setRGB(r, g, b, THREE.SRGBColorSpace); return `vec3(${c.r.toFixed(5)}, ${c.g.toFixed(5)}, ${c.b.toFixed(5)})` }

// Rock: the template's bedrock (strata banded by height with the phase warped at three scales, iron
// staining, lichen in the damp) made solid for close range: triplanar so a vertical face is not a
// stretched smear, meso facets and vertical joints from the detail tile, and thin bedding planes that
// step the face into ledges in the normal, so a cliff reads as rock from a boat and from its top.
const ROCK_GLSL = /* glsl */`
float tStep(float a, float b, float x) { float t = clamp((x - a) / (b - a), 0.0, 1.0); return t * t * (3.0 - 2.0 * t); }
vec4 tDet(vec2 p) { vec4 d = texture2D(uTerrDetail, p); d.xy = d.xy * 2.0 - 1.0; return d; }
// triplanar tap: xyz = world-space gradient of the tile's relief, w = relief. stretch < 1 elongates the
// side projections vertically (joints and flutes run down a face, not across it)
vec4 rkTri(vec3 p, vec3 w, float period, float stretch) {
  vec4 ax = tDet(vec2(p.z, p.y * stretch) / period);
  vec4 ay = tDet(p.xz / period + 0.37);
  vec4 az = tDet(vec2(p.x, p.y * stretch) / period + 0.71);
  vec3 g = w.x * vec3(0.0, ax.y * stretch, ax.x) + w.y * vec3(ay.x, 0.0, ay.y) + w.z * vec3(az.x, az.y * stretch, 0.0);
  return vec4(g, w.x * ax.z + w.y * ay.z + w.z * az.z);
}
vec3 rkPerturb(vec3 N, vec3 g) { return normalize(N - (g - N * dot(N, g))); }
float rkBed(float y) { float f = fract(y); return tStep(0.0, 0.16, f) * tStep(1.0, 0.62, f); } // hard bed proud of a soft parting
// p: metres in the rock's own frame, N: unit geometric normal in that frame, damp: 0..1, near: 1 close, 0 far
vec3 terrRock(vec3 p, vec3 N, float damp, float near, out vec3 Nout) {
  vec3 w = pow(abs(N), vec3(4.0)); w /= (w.x + w.y + w.z);
  vec4 meso = rkTri(p, w, 13.0, 0.42);
  vec4 fine = rkTri(p, w, 3.1, 0.8);
  vec4 grit = rkTri(p, w, 0.83, 1.0);
  float warp = (meso.w - 0.5) * 5.4 + (fine.w - 0.5) * 1.7;
  float broad = sin(p.y * 0.085 + warp) * 0.5 + 0.5;
  float bedT = 1.1 + 0.9 * meso.w;                          // bed thickness 1.1–2 m
  float by = p.y / bedT + (meso.w - 0.5) * 1.6 + (fine.w - 0.5) * 0.35;
  float bed = rkBed(by), dBed = (rkBed(by + 0.04) - rkBed(by - 0.04)) / (0.08 * bedT);
  float parting = 1.0 - tStep(0.0, 0.09, fract(by)) * tStep(1.0, 0.91, fract(by));
  vec3 rock = mix(${lin(0.20, 0.185, 0.165)}, ${lin(0.44, 0.40, 0.35)}, broad * 0.55 + 0.25);
  rock = mix(rock, ${lin(0.34, 0.21, 0.13)}, tStep(0.55, 0.85, fine.w) * 0.45);   // iron staining
  rock = mix(rock, ${lin(0.16, 0.20, 0.12)}, tStep(0.25, 0.7, damp) * 0.35);      // lichen in the damp
  rock *= 0.89 + 0.22 * grit.w;
  rock *= mix(1.0, 0.86 + 0.24 * bed, 0.7) * (1.0 - 0.28 * parting * near);
  float joint = tStep(0.07, 0.0, abs(meso.w - 0.5)) * tStep(0.2, 0.6, 1.0 - abs(N.y));
  rock *= 1.0 - 0.38 * joint * near;
  vec3 g = meso.xyz * 0.55 + fine.xyz * 0.32 * (0.4 + 0.6 * near) + grit.xyz * 0.16 * near + vec3(0.0, -dBed * 0.22, 0.0);
  Nout = rkPerturb(N, g);
  // weathering: up-facing ledges hold dust and a little moss
  rock = mix(rock, ${lin(0.30, 0.31, 0.22)}, tStep(0.62, 0.92, mix(N.y, Nout.y, 0.4)) * (0.25 + 0.3 * fine.w));
  return rock;
}
`

// ---------------------------------------------------------------------------------------------
const TERRAIN_FRAG = /* glsl */`
vec3 terrN; float terrRough = 0.9; float terrAO = 1.0; float terrSpark = 0.0; vec3 terrFacet = vec3(0.0, 1.0, 0.0);
vec3 terrCaustic = vec3(0.0);
{
  vec3 P = vTerrPos;
  float hgt = P.y - uSeaLevel;
  vec2 xz = P.xz;
  vec2 tuv = (xz - uBoundsMin) / uBoundsSize;
  float inMap = step(0.0, tuv.x) * step(tuv.x, 1.0) * step(0.0, tuv.y) * step(tuv.y, 1.0);
  vec4 HS = texture2D(uHeightTex, tuv);
  vec4 FL = texture2D(uFields, tuv);
  vec4 MK = texture2D(uMasks, tuv);
  vec3 Ng = normalize(vTerrNrm);
  float grad = sqrt(max(1.0 - Ng.y * Ng.y, 0.0)) / max(Ng.y, 0.05);   // rise / run of the mesh
  float slopeF = min(1.0, grad / 2.2);
  float dS = mix(hgt * 30.0 + 20.0, HS.y, inMap);
  float flow = FL.x * inMap, sed = FL.y * inMap, concav = (FL.z * 2.0 - 1.0) * inMap;
  float density = mix(tStep(uSandTop - 0.6, uSandTop + 1.1, hgt) * (1.0 - tStep(1.6, 2.5, grad)) * (1.0 - tStep(uTreeLine, uTreeLine * 1.45, hgt)), HS.w, inMap);
  float bedrock = MK.a * inMap;
  terrAO = mix(1.0, FL.w, inMap);
  float dCam = length(vTerrWorld - cameraPosition);
  float near = tStep(260.0, 40.0, dCam);

  // meadow-scale noise from the Perlin tile (never a value-noise lattice: it prints squares)
  vec4 nA = tDet(vec2(xz.x * 0.8 - xz.y * 0.6, xz.x * 0.6 + xz.y * 0.8) / 57.0);
  vec4 nB = tDet(xz / 17.0 + 0.31);
  vec4 nC = tDet(xz / 4.3 + 0.67);
  float fine = nA.z, fine2 = nB.z, micro = nC.z;
  float mottle = fine * 0.5 + fine2 * 0.32 + micro * 0.18;

  // ---- meadow (world/island.js): dries on convex ground, stays green where water runs
  float convex = tStep(0.03, 0.30, -concav);
  vec3 turf = mix(${lin(0.10, 0.16, 0.08)}, ${lin(0.24, 0.38, 0.19)}, clamp(fine * 0.44 + fine2 * 0.22 + convex * 0.16 + nA.w * 0.25 - 0.05, 0.0, 1.0));
  float dry = clamp(convex * 0.32 + tStep(0.14, 0.64, slopeF) * 0.14 + tStep(30.0, 140.0, hgt) * 0.12 + (fine - 0.5) * 0.26
    + tStep(0.30, 0.04, density) * 0.30 - flow * 0.45 - sed * 0.25, 0.0, 1.0);
  turf = mix(turf, ${lin(0.46, 0.42, 0.22)}, dry);
  turf = mix(turf, uMeadowColor * (0.85 + 0.3 * mottle), uMeadowMix);
  turf *= 1.0 + (micro - 0.5) * 0.32 * near;
  turf *= mix(1.0, uUnderBlades, tStep(0.05, 0.55, density));
  vec3 soil = mix(${lin(0.21, 0.175, 0.10)}, ${lin(0.32, 0.27, 0.15)}, mottle);
  vec3 scrub = mix(${lin(0.105, 0.145, 0.075)}, ${lin(0.20, 0.26, 0.115)}, fine2 * 0.55 + mottle * 0.45);
  float bareW = max(max(tStep(0.58, 0.98, slopeF), tStep(uTreeLine * 0.85, uTreeLine * 1.15, hgt)), tStep(0.45, 0.85, flow) * tStep(0.10, 0.30, slopeF));
  vec3 land = mix(mix(scrub, soil, bareW), turf, tStep(0.015, 0.26, density));
  vec3 scree = mix(${lin(0.30, 0.28, 0.25)}, ${lin(0.46, 0.43, 0.38)}, fine2) * (0.85 + 0.3 * micro);
  vec3 gravel = mix(${lin(0.36, 0.34, 0.30)}, ${lin(0.52, 0.49, 0.44)}, micro);

  // ---- class weights, continuous (bedrock from the slope the mesh actually has, broken by noise)
  float gN = grad + (fine2 - 0.5) * 0.5 + (fine - 0.5) * 0.3;
  float rockW = max(max(tStep(uRockSlope.x, uRockSlope.y, gN), tStep(uTreeLine, uTreeLine * 1.5, hgt)), bedrock);
  float screeW = tStep(0.85, 1.25, grad) * tStep(2.2, 1.6, grad) * tStep(8.0, 40.0, hgt) * tStep(0.05, 0.35, concav) * (1.0 - rockW);
  float gravelW = tStep(0.50, 0.92, flow) * tStep(0.13, 0.48, grad) * tStep(1.32, 0.75, grad) * (1.0 - rockW);
  land = mix(land, gravel, gravelW * 0.7);
  land = mix(land, scree, screeW);
  vec3 N = Ng;
  // ground meso-detail is a few degrees, never more (the "camouflage at golden hour" trap)
  N = normalize(N + vec3(nB.x + nC.x * 0.7, 0.0, nB.y + nC.y * 0.7) * 0.05 * near);
  float rough = 0.92;
  if (rockW > 0.003) {
    vec3 rN;
    vec3 rock = terrRock(P, Ng, flow, near, rN);
    land = mix(land, rock, rockW);
    N = normalize(mix(N, rN, rockW));
    rough = mix(rough, 0.82, rockW);
  }
  // building pads: compacted soil and fine gravel, flat-normalled
  float padS = texture2D(uPads, tuv).r * inMap;
  if (padS > 0.002) {
    vec3 padCol = mix(${lin(0.33, 0.29, 0.23)}, ${lin(0.47, 0.43, 0.36)}, clamp(micro * 0.7 + fine2 * 0.3, 0.0, 1.0)) * (0.92 + 0.16 * tDet(xz / 1.3).z);
    land = mix(land, padCol, padS);
    N = normalize(mix(N, normalize(Ng + vec3(nC.x, 0.0, nC.y) * 0.03), padS));
    rough = mix(rough, 0.95, padS);
  }
  float wetL = clamp(tStep(0.25, 0.75, flow) * 0.45 + tStep(0.1, 0.6, concav) * 0.15, 0.0, 0.55);
  land *= 1.0 - wetL * 0.5;
  rough = mix(rough, 0.55, wetL);

  // ---- the beach (world/sand.js beachSurface + the shared waterline)
  float sandF = tStep(uSandTop + 0.7, uSandTop - 0.6, hgt) * tStep(0.55, 0.28, slopeF) * tStep(260.0, 120.0, dS) * (1.0 - bedrock) * (1.0 - padS);
  vec3 base = land;
  float wetness = 0.0;
  vec4 W = vec4(0.0);
  if (hgt < 3.5 && dS < 60.0) {
    W = shoreSample(xz, hgt, dS, uTime * uSwash);
    float lvl = W.x - W.w;
    float wetNow = tStep(lvl + 0.14, lvl - 0.02, hgt);
    float wetDamp = tStep(W.z + 0.22, W.z + 0.01, hgt) * 0.6;
    float wetPool = tStep(0.14, -0.02, hgt) * tStep(45.0, 6.0, dS);
    wetness = max(max(wetNow, wetDamp), wetPool);
  }
  if (sandF > 0.002) {
    vec2 e2 = vec2(uTexel, 0.0);
    float gxS = texture2D(uHeightTex, tuv + e2.xy).y - texture2D(uHeightTex, tuv - e2.xy).y;
    float gzS = texture2D(uHeightTex, tuv + e2.yx).y - texture2D(uHeightTex, tuv - e2.yx).y;
    vec2 shoreDir = normalize(vec2(gxS, gzS) + 1e-5);
    vec4 dF = tDet(xz / 0.55);
    vec2 rm = vec2(xz.x * 0.8196 - xz.y * 0.5729, xz.x * 0.5729 + xz.y * 0.8196);   // rotated 0.61 rad
    vec2 rp = vec2(xz.x * 0.9582 + xz.y * 0.2860, -xz.x * 0.2860 + xz.y * 0.9582);  // rotated -0.29 rad
    vec4 dM = tDet(rm / 9.0);
    vec4 dP = tDet(rp / 67.0);
    float onSand = tStep(3.4, 0.9, hgt) * (1.0 - wetness * wetness * 0.85);
    float ridge = (pow(1.0 - abs(sin(dS * 0.48 + (dP.z - 0.5) * 4.4)), 1.5) - 0.27) * tStep(220.0, 40.0, dCam) * 0.10 * onSand;
    vec2 windDir = vec2(0.80, 0.60);
    float comb = (pow(1.0 - abs(sin(dot(xz, windDir) * 24.0 + (dM.z - 0.5) * 5.2 + (dP.z - 0.5) * 3.0)), 1.5) - 0.27)
      * tStep(48.0, 6.0, dCam) * 0.105 * onSand * tStep(0.28, 0.60, dP.w);
    float clump = dM.w * 0.9 + 0.55;
    vec2 gM = vec2(dM.x * 0.8196 + dM.y * 0.5729, dM.y * 0.8196 - dM.x * 0.5729);
    vec2 relief = (dF.xy * clump * 0.24 + gM * 0.17) * (onSand * 0.75 + 0.25);
    vec3 sandN = normalize(Ng + vec3(relief.x, 0.0, relief.y) + vec3(shoreDir.x, 0.0, shoreDir.y) * ridge + vec3(windDir.x, 0.0, windDir.y) * comb);
    float heavies = dP.z * 0.55 + dM.z * 0.45;
    vec3 sandDry = mix(${lin(0.78, 0.715, 0.595)}, ${lin(0.44, 0.36, 0.26)}, tStep(0.34, 0.90, heavies) * 0.32);
    sandDry *= 1.0 + (dF.z - 0.5) * clump * 0.17;
    sandDry *= 1.0 + (dM.z - 0.5) * 0.24;
    vec2 gc = floor(xz * 26.0), gf = fract(xz * 26.0);
    float g1 = fract(sin(dot(gc, vec2(127.1, 311.7))) * 43758.5453), g2 = fract(sin(dot(gc + 5.3, vec2(127.1, 311.7))) * 43758.5453);
    float grain = fract(sin(dot(gc + 11.7, vec2(127.1, 311.7))) * 43758.5453);
    float gD = length(gf - (vec2(g1, g2) * 0.66 + 0.17));
    float drowned = tStep(0.05, -0.5, hgt);
    float shell = tStep(0.34, 0.12, gD) * tStep(0.90, 0.98, grain) * tStep(30.0, 4.0, dCam);
    sandDry = mix(sandDry, ${lin(0.94, 0.91, 0.84)}, shell * mix(0.5, 0.12, drowned));
    vec3 sandA = pow(sandDry, vec3(wetness + 1.0)) * (1.0 - wetness * 0.05)
      * (tStep(0.5, 0.15, gD) * 0.09 * tStep(90.0, 10.0, dCam) + 0.965) * (1.0 + (ridge + comb) * 0.8);
    float sandR = mix(mix(0.95, 0.09, pow(wetness, 0.65)), 0.62, drowned);
    terrFacet = normalize(sandN + vec3(g1 - 0.5, 0.0, g2 - 0.5) * 0.9);
    terrSpark = tStep(0.42, 0.16, gD) * (1.0 - wetness) * tStep(90.0, 12.0, dCam) * sandF * (1.0 - drowned);
    base = mix(land, sandA, sandF);
    N = normalize(mix(N, sandN, sandF));
    rough = mix(rough, sandR, sandF);
  }
  // wet ground that is not sand (rock, gravel at the waterline) darkens and glosses too
  base *= 1.0 - wetness * (1.0 - sandF) * 0.35;
  rough = mix(rough, 0.25, wetness * (1.0 - sandF) * 0.7);
  // foam drying on the sand between waves: the residue of the sheet, a lace of bubble rafts
  if (W.y > 0.001) {
    float lvl = W.x - W.w;
    float lace = tDet(xz / 2.6).z;
    float drying = W.y * tStep(W.z + 0.02, W.z - 0.22, hgt) * tStep(lvl - 0.05, lvl + 0.10, hgt) * tStep(0.36, 0.76, lace) * 0.8;
    base = mix(base, vec3(0.80, 0.82, 0.82), clamp(drying, 0.0, 1.0));
    rough = mix(rough, 0.7, clamp(drying, 0.0, 1.0));
  }
  // ---- the bed: light reaches it through a water column, and the surface focuses it into caustics
  float column = max(-hgt, 0.0) * uUnderwater;
  base *= exp(-vec3(0.115, 0.028, 0.016) * column);
  if (column > 0.01) {
    vec2 tt = vec2(0.023, 0.011) * uTime, tu = vec2(-0.017, 0.019) * uTime;
    float capA = tDet(xz / 7.0 + tt).x, capB = tDet(xz / 4.6 + tu).x;
    float web = pow(max(1.0 - abs(capA + capB) * 2.6, 0.0), 4.0);
    terrCaustic = vec3(web * exp(-column * 0.12) * tStep(0.03, 0.30, column) * 0.22);
    base = mix(base, ${lin(0.03, 0.06, 0.075)}, clamp((column - 1.4) / 7.0, 0.0, 1.0));
  }
  diffuseColor.rgb = base;
  terrN = N; terrRough = rough;
}
`

function makeTerrainMaterial(u, name) {
  const material = new THREE.MeshStandardMaterial({ name, roughness: 0.9, metalness: 0 })
  material.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, u)
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vTerrPos;\nvarying vec3 vTerrNrm;\nvarying vec3 vTerrWorld;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\nvTerrPos = transformed; vTerrNrm = objectNormal; vTerrWorld = (modelMatrix * vec4(transformed, 1.0)).xyz;')
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>
varying vec3 vTerrPos; varying vec3 vTerrNrm; varying vec3 vTerrWorld;
uniform sampler2D uTerrDetail, uHeightTex, uFields, uMasks, uSunVis, uPads;
uniform vec2 uBoundsMin, uBoundsSize, uRockSlope; uniform float uSeaLevel, uSandTop, uTreeLine, uTime, uSwash, uUnderwater, uTexel, uUnderBlades, uMeadowMix;
uniform vec3 uMeadowColor, uSunDirW;
${SHORE_GLSL}
${ROCK_GLSL}
float terrSunVisFor(vec3 dirView) {
  vec2 tuv = (vTerrPos.xz - uBoundsMin) / uBoundsSize;
  float inMap = step(0.0, tuv.x) * step(tuv.x, 1.0) * step(0.0, tuv.y) * step(tuv.y, 1.0);
  float match = smoothstep(0.990, 0.999, dot(dirView, normalize((viewMatrix * vec4(uSunDirW, 0.0)).xyz)));
  return mix(1.0, texture2D(uSunVis, tuv).r, match * inMap);
}`)
      .replace('#include <color_fragment>', TERRAIN_FRAG)
      .replace('#include <roughnessmap_fragment>', 'float roughnessFactor = terrRough;')
      .replace('#include <normal_fragment_maps>', 'normal = normalize((viewMatrix * vec4(terrN, 0.0)).xyz);')
      .replace('#include <lights_fragment_begin>', THREE.ShaderChunk.lights_fragment_begin.replace(
        'getDirectionalLightInfo( directionalLight, directLight );',
        'getDirectionalLightInfo( directionalLight, directLight );\n\t\tdirectLight.color *= terrSunVisFor( directLight.direction );'))
      .replace('#include <lights_fragment_end>', `#include <lights_fragment_end>
#if NUM_DIR_LIGHTS > 0
  {
    // sand sparkle: the few quartz facets aligned sun-to-eye; and caustics on the bed
    vec3 Ld = directionalLights[0].direction, Vv = normalize(vViewPosition);
    float vis = terrSunVisFor(Ld);
    vec3 fN = normalize((viewMatrix * vec4(terrFacet, 0.0)).xyz);
    float sp = pow(max(dot(reflect(-Vv, fN), Ld), 0.0), 900.0) * terrSpark;
    reflectedLight.directSpecular += directionalLights[0].color * (sp * 2.4 * vis);
    reflectedLight.directDiffuse += directionalLights[0].color * terrCaustic * vis * max(dot(geometryNormal, Ld), 0.0);
  }
#endif`)
      .replace('#include <aomap_fragment>', '#include <aomap_fragment>\nreflectedLight.indirectDiffuse *= terrAO; reflectedLight.indirectSpecular *= mix(1.0, terrAO, 0.6);')
  }
  material.customProgramCacheKey = () => 'terrain-v2'
  return material
}

// ---------------------------------------------------------------------------------------------
export function createTerrain(opts = {}) {
  const T0 = performance.now(), timings = {}
  let tMark = T0
  const mark = (k) => { const t = performance.now(); timings[k] = Math.round(t - tMark); tMark = t }
  const presetName = PRESETS[opts.preset] ? opts.preset : 'island'
  const base = PRESETS[presetName]
  const o = {
    size: opts.size ?? base.size,
    resolution: Math.round(clamp(opts.resolution ?? 512, 64, 1024)),
    seed: (opts.seed ?? 1) | 0,
    seaLevel: opts.seaLevel ?? 0,
    heightScale: opts.heightScale ?? 1,
    erosion: clamp(opts.erosion ?? 1, 0, 1),
    erosionIterations: opts.erosionIterations ?? 130,
    apron: opts.apron ?? 2500,
    swash: opts.swash ?? base.swash,
    grassCover: !!opts.grassCover,
    name: opts.name ?? 'Terrain',
  }
  const R = o.resolution, E = Math.round(clamp(opts.erosionResolution ?? R / 2, 32, R))
  const rand = mulberry32(o.seed * 7919 + 13)
  const O = (wl) => makeOctave(wl, (rand() * 2147483647) | 0)
  const OV = (wl) => makeValueOctave(wl, (rand() * 2147483647) | 0)
  const preset = presetName === 'coast' ? coastPreset(o, O, rand) : presetName === 'hills' ? hillsPreset(o, O) : presetName === 'valley' ? valleyPreset(o, O) : islandPreset(o, OV)
  const { sandTop, treeLine } = preset
  const half = o.size / 2, texel = o.size / R, minX = -half, minZ = -half
  const NN = R * R

  // ---- 1 · macro synthesis at full resolution
  const height = new Float32Array(NN), coastD = new Float32Array(NN), bay = new Float32Array(NN), hard = new Float32Array(NN), bare = new Float32Array(NN)
  const tmp = new Float64Array(5)
  LOD = 0
  for (let j = 0; j < R; j++) {
    const z = minZ + (j + 0.5) * texel
    for (let i = 0; i < R; i++) {
      const k = j * R + i
      preset.macro(minX + (i + 0.5) * texel, z, tmp)
      height[k] = tmp[0]; coastD[k] = tmp[1]; bay[k] = tmp[2]; hard[k] = tmp[3]; bare[k] = tmp[4]
    }
  }
  mark('synthesis')

  // ---- 2 · erosion at E (box-filtered down), the delta brought back up and faded out at the map
  // border so the analytic apron continues it without a seam. The designed sea floor is held.
  const flow = new Float32Array(NN), sediment = new Float32Array(NN)
  if (o.erosion > 0 && o.erosionIterations > 0) {
    const f = R / E, eH = new Float32Array(E * E), eK = new Float32Array(E * E)
    for (let j = 0; j < E; j++) for (let i = 0; i < E; i++) {
      let sh = 0, sk = 0, n = 0
      const i0 = Math.floor(i * f), i1 = Math.max(i0 + 1, Math.floor((i + 1) * f)), j0 = Math.floor(j * f), j1 = Math.max(j0 + 1, Math.floor((j + 1) * f))
      for (let jj = j0; jj < j1; jj++) for (let ii = i0; ii < i1; ii++) { sh += height[jj * R + ii]; sk += hard[jj * R + ii]; n++ }
      eH[j * E + i] = sh / n; eK[j * E + i] = sk / n
    }
    // The pipe model is not scale-invariant: on 3–6 m texels it barely carves (measured: ~1 m against
    // ~19 m at the template's 2.15 m). So erode a geometrically similar copy — heights scaled by
    // 2.15 / texel, slopes unchanged — at the texel the constants were calibrated for, and scale the
    // change back. Channels then cut as deep, relative to the grid, as the original's.
    const orig = Float32Array.from(eH), sim = 2.15 / (o.size / E)
    for (let i = 0; i < E * E; i++) eH[i] *= sim
    const er = erodeCPU(E, 2.15, o.erosionIterations, eH, eK)
    let maxW = 1e-6, maxS = 1e-6
    for (let i = 0; i < E * E; i++) { if (er.water[i] > maxW) maxW = er.water[i]; if (er.sediment[i] > maxS) maxS = er.sediment[i] }
    const delta = new Float32Array(E * E)
    for (let i = 0; i < E * E; i++) delta[i] = (er.height[i] / sim - orig[i]) * smooth(-3.0, 1.5, orig[i]) * o.erosion
    mark('erosion')
    // bicubic (Catmull-Rom) for the height delta, bilinear for the flow fields
    const cr = (p0, p1, p2, p3, t) => p1 + 0.5 * t * (p2 - p0 + t * (2 * p0 - 5 * p1 + 4 * p2 - p3 + t * (3 * (p1 - p2) + p3 - p0)))
    const at = (a, x, y) => a[(y < 0 ? 0 : y >= E ? E - 1 : y) * E + (x < 0 ? 0 : x >= E ? E - 1 : x)]
    const edge = Math.max(4, R * 0.04)
    for (let j = 0; j < R; j++) {
      const gy = (j + 0.5) / f - 0.5, y0 = Math.floor(gy), ty = gy - y0
      const fy = smooth(0, edge, Math.min(j, R - 1 - j))
      for (let i = 0; i < R; i++) {
        const gx = (i + 0.5) / f - 0.5, x0 = Math.floor(gx), tx = gx - x0
        const k = j * R + i, fade = fy * smooth(0, edge, Math.min(i, R - 1 - i))
        const r0 = cr(at(delta, x0 - 1, y0 - 1), at(delta, x0, y0 - 1), at(delta, x0 + 1, y0 - 1), at(delta, x0 + 2, y0 - 1), tx)
        const r1 = cr(at(delta, x0 - 1, y0), at(delta, x0, y0), at(delta, x0 + 1, y0), at(delta, x0 + 2, y0), tx)
        const r2 = cr(at(delta, x0 - 1, y0 + 1), at(delta, x0, y0 + 1), at(delta, x0 + 1, y0 + 1), at(delta, x0 + 2, y0 + 1), tx)
        const r3 = cr(at(delta, x0 - 1, y0 + 2), at(delta, x0, y0 + 2), at(delta, x0 + 1, y0 + 2), at(delta, x0 + 2, y0 + 2), tx)
        height[k] += cr(r0, r1, r2, r3, ty) * fade
        const w00 = at(er.water, x0, y0), w10 = at(er.water, x0 + 1, y0), w01 = at(er.water, x0, y0 + 1), w11 = at(er.water, x0 + 1, y0 + 1)
        const s00 = at(er.sediment, x0, y0), s10 = at(er.sediment, x0 + 1, y0), s01 = at(er.sediment, x0, y0 + 1), s11 = at(er.sediment, x0 + 1, y0 + 1)
        const w = (w00 + (w10 - w00) * tx) * (1 - ty) + (w01 + (w11 - w01) * tx) * ty
        const s = (s00 + (s10 - s00) * tx) * (1 - ty) + (s01 + (s11 - s01) * tx) * ty
        flow[k] = Math.min(1, w / (maxW * 0.18)) * fade * o.erosion
        sediment[k] = Math.min(1, s / (maxS * 0.35)) * fade * o.erosion
      }
    }
    mark('upsample')
  }

  // ---- 2c · one island: keep the largest land body, drown fragments with their bank (island only)
  if (presetName === 'island') {
    const label = new Int32Array(NN).fill(-1), stack = []
    let next = 0, best = -1, bestN = 0
    for (let s = 0; s < NN; s++) {
      if (height[s] <= 0 || label[s] >= 0) continue
      const id = next++; let n = 0; stack.push(s)
      while (stack.length) {
        const i = stack.pop()
        if (label[i] >= 0 || height[i] <= 0) continue
        label[i] = id; n++
        const x = i % R, y = (i / R) | 0
        if (x > 0) stack.push(i - 1); if (x < R - 1) stack.push(i + 1); if (y > 0) stack.push(i - R); if (y < R - 1) stack.push(i + R)
      }
      if (n > bestN) { bestN = n; best = id }
    }
    const BLEND = Math.round(118 / texel), step = new Int16Array(NN).fill(-1), patch = []
    for (let i = 0; i < NN; i++) if (label[i] >= 0 && label[i] !== best) { step[i] = 0; patch.push(i) }
    for (let q = 0; q < patch.length; q++) {
      const i = patch[q]; if (step[i] >= BLEND) continue
      const x = i % R, y = (i / R) | 0
      const nb = [x > 0 ? i - 1 : -1, x < R - 1 ? i + 1 : -1, y > 0 ? i - R : -1, y < R - 1 ? i + R : -1]
      for (const j of nb) { if (j < 0 || step[j] >= 0 || label[j] === best) continue; step[j] = step[i] + 1; patch.push(j) }
    }
    for (const i of patch) height[i] = Math.min(height[i], -18 * (1 - smooth(0, BLEND, step[i])))
  }

  // ---- 2b · coastal deposition (fills the coves onto a sand ramp; never raises, never planes a
  // hillside) + preset post (the valley's river); both pointwise, so the apron gets them too
  const post = (x, z, h, cD, b) => {
    if (preset.rampRate > 0 && b > 0.002) {
      const ramp = 0.15 + preset.rampRate * Math.max(0, cD)
      if (h > ramp) { const k = b * smooth(preset.depoTop, 3.0, h); if (k > 0.002) h += (ramp - h) * k }
    }
    return preset.post ? preset.post(x, z, h) : h
  }
  for (let j = 0; j < R; j++) for (let i = 0; i < R; i++) {
    const k = j * R + i
    height[k] = post(minX + (i + 0.5) * texel, minZ + (j + 0.5) * texel, height[k], coastD[k], bay[k])
  }

  // ---- pits the sea cannot reach would render as round ponds of ocean in a meadow: fill them
  if (base.sea) {
    const SEA = 0.25, reach = new Uint8Array(NN), stack = []
    for (let x = 0; x < R; x++) stack.push(x, (R - 1) * R + x)
    for (let y = 0; y < R; y++) stack.push(y * R, y * R + R - 1)
    while (stack.length) {
      const i = stack.pop()
      if (reach[i] || height[i] >= SEA) continue
      reach[i] = 1
      const x = i % R, y = (i / R) | 0
      if (x > 0) stack.push(i - 1); if (x < R - 1) stack.push(i + 1); if (y > 0) stack.push(i - R); if (y < R - 1) stack.push(i + R)
    }
    for (let i = 0; i < NN; i++) if (height[i] < SEA && !reach[i]) height[i] = Math.max(0.12, SEA + (height[i] - SEA) * 0.10)
  }
  // ---- 2c · building pads: level sites with a smooth ring, before fields/masks/mesh so every output
  // agrees. Cutting uses the full ring, filling a half-width one (a cliff-top pad does not grow an
  // embankment out over the edge). padW = the pad surface (+2.5 m): no grass/trees/boulders, soil shading
  const padW = new Float32Array(NN), pads = []
  for (const p0 of opts.pads ?? []) {
    const p = { ...p0 }, blend = Math.max(0.5, p.blend ?? 12), ca = Math.cos(p.angle ?? 0), sa = Math.sin(p.angle ?? 0)
    const circ = p.radius !== undefined, hw = (p.width ?? 10) / 2, hd = (p.depth ?? 10) / 2
    const outside = (x, z) => {
      const dx = x - p.x, dz = z - p.z
      if (circ) return Math.max(0, Math.hypot(dx, dz) - p.radius)
      const lx = Math.abs(dx * ca + dz * sa) - hw, lz = Math.abs(-dx * sa + dz * ca) - hd
      return Math.hypot(Math.max(lx, 0), Math.max(lz, 0)) + Math.min(Math.max(lx, lz), 0)
    }
    const ext = (circ ? p.radius : Math.hypot(hw, hd)) + blend
    const i0 = clamp(Math.floor((p.x - ext - minX) / texel), 0, R - 1), i1 = clamp(Math.ceil((p.x + ext - minX) / texel), 0, R - 1)
    const j0 = clamp(Math.floor((p.z - ext - minZ) / texel), 0, R - 1), j1 = clamp(Math.ceil((p.z + ext - minZ) / texel), 0, R - 1)
    if (p.y === undefined) {
      let sum = 0, n = 0
      for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) if (outside(minX + (i + 0.5) * texel, minZ + (j + 0.5) * texel) <= 0) { sum += height[j * R + i]; n++ }
      p.y = (n ? sum / n : height[clamp(Math.round((p.z - minZ) / texel - 0.5), 0, R - 1) * R + clamp(Math.round((p.x - minX) / texel - 0.5), 0, R - 1)]) + o.seaLevel
    }
    const target = p.y - o.seaLevel
    for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) {
      const k = j * R + i, e = outside(minX + (i + 0.5) * texel, minZ + (j + 0.5) * texel), h = height[k]
      const w = h > target ? smooth(blend, 0, e) : smooth(blend * 0.5, 0, e)
      height[k] = h + (target - h) * w
      padW[k] = Math.max(padW[k], smooth(2.5, 0, e))
    }
    pads.push(p)
  }
  for (let i = 0; i < NN; i++) if (padW[i] > 0) bare[i] *= 1 - padW[i]
  mark('coast')

  // ---- 3 · fields off the final height
  const slope = new Float32Array(NN), concav = new Float32Array(NN), density = new Float32Array(NN), ao = new Float32Array(NN)
  const dp1 = O(51), dp2 = O(25), dp3 = O(12), dp4 = O(6.3), w1 = O(o.size / 7 > 300 ? 300 : o.size / 7), w2 = O(110), g1 = O(140)
  for (let y = 0; y < R; y++) {
    const ym = (y > 0 ? y - 1 : 0) * R, yp = (y < R - 1 ? y + 1 : R - 1) * R, z = minZ + (y + 0.5) * texel
    for (let x = 0; x < R; x++) {
      const i = y * R + x, h = height[i]
      const hxm = height[y * R + (x > 0 ? x - 1 : 0)], hxp = height[y * R + (x < R - 1 ? x + 1 : R - 1)], hym = height[ym + x], hyp = height[yp + x]
      const sl = Math.hypot(hxp - hxm, hyp - hym) / (2 * texel)
      slope[i] = sl
      const slF = Math.min(1, sl / 2.2)
      const cv = clamp((hxm + hxp + hym + hyp - 4 * h) / (texel * 1.6) * (texel / 2.15), -1, 1)
      concav[i] = cv
      const wx = minX + (x + 0.5) * texel
      const fb = 0.44 * dp1(wx, z) + 0.28 * dp2(wx, z) + 0.18 * dp3(wx, z) + 0.10 * dp4(wx, z)
      let den = 0.87 + 0.13 * smooth(0.30, 0.70, fb)
      den *= 1 - 0.14 * Math.max(0, -cv)
      den *= smooth(sandTop - 0.6, sandTop + 1.1, h)
      den *= 1 - smooth(1.60, 2.50, sl)
      den *= 1 - smooth(treeLine, treeLine * 1.45, h)
      den *= 1 - 0.55 * smooth(0.48, 0.95, flow[i]) * smooth(0.10, 0.34, slF)
      den *= 0.96 + 0.06 * smooth(0.02, 0.25, flow[i]) + 0.10 * sediment[i]
      den *= 1 - smooth(0.4, 0.8, bare[i])
      den *= 1 - padW[i]
      density[i] = Math.min(1, Math.max(0, den))
      ao[i] = Math.min(1, 0.80 + 0.20 * (1 - slF) - 0.22 * Math.max(0, cv))
    }
  }
  mark('fields')

  // ---- signed shore distance (m, + inland): chamfer transform, land = above the still water
  const dShore = new Float32Array(NN)
  {
    const BIG = 1e7, dL = new Float32Array(NN), dW = new Float32Array(NN)
    for (let i = 0; i < NN; i++) { const land = height[i] > 0; dL[i] = land ? 0 : BIG; dW[i] = land ? BIG : 0 }
    const chamfer = (d) => {
      for (let y = 0; y < R; y++) for (let x = 0; x < R; x++) {
        const i = y * R + x; let m = d[i]
        if (x > 0) m = Math.min(m, d[i - 1] + 1)
        if (y > 0) { m = Math.min(m, d[i - R] + 1); if (x > 0) m = Math.min(m, d[i - R - 1] + 1.4142); if (x < R - 1) m = Math.min(m, d[i - R + 1] + 1.4142) }
        d[i] = m
      }
      for (let y = R - 1; y >= 0; y--) for (let x = R - 1; x >= 0; x--) {
        const i = y * R + x; let m = d[i]
        if (x < R - 1) m = Math.min(m, d[i + 1] + 1)
        if (y < R - 1) { m = Math.min(m, d[i + R] + 1); if (x < R - 1) m = Math.min(m, d[i + R + 1] + 1.4142); if (x > 0) m = Math.min(m, d[i + R - 1] + 1.4142) }
        d[i] = m
      }
    }
    chamfer(dL); chamfer(dW)
    for (let i = 0; i < NN; i++) dShore[i] = Math.min(height[i] > 0 ? dW[i] * texel : -dL[i] * texel, 5000)
  }
  mark('shore')

  // ---- masks: grass, trees (broadleaf stands inland), palms (coastal groves), sand, rock, boulders
  const mGrass = new Uint8Array(NN), mTree = new Uint8Array(NN), mSand = new Uint8Array(NN), mRock = new Uint8Array(NN), mPalm = new Uint8Array(NN)
  const rockF = new Float32Array(NN)
  for (let y = 0; y < R; y++) {
    const z = minZ + (y + 0.5) * texel
    for (let x = 0; x < R; x++) {
      const i = y * R + x, h = height[i], sl = slope[i], dS = dShore[i], wx = minX + (x + 0.5) * texel
      const sandF = smooth(sandTop + 0.7, sandTop - 0.6, h) * smooth(1.21, 0.62, sl) * smooth(260, 120, dS) * (1 - bare[i]) * (h > -1.5 ? 1 : 0)
      const rk = Math.max(smooth(1.25, 2.0, sl), smooth(treeLine, treeLine * 1.5, h), bare[i] * (h > -1 ? 1 : 0))
      const stand = 0.64 * w1(wx, z) + 0.36 * w2(wx, z)
      const tree = smooth(0.30, 0.42, stand) * smooth(Math.min(40, o.size * 0.03), Math.min(60, o.size * 0.05), dS) * smooth(sandTop + 1.0, sandTop + 2.5, h)
        * smooth(treeLine * 0.95, treeLine * 0.85, h) * smooth(1.2, 0.9, sl) * smooth(0.75, 0.6, flow[i]) * (1 - rk)
      const palm = base.sea ? smooth(0.26, 0.36, g1(wx, z)) * smooth(5, 9, dS) * smooth(150, 120, dS) * smooth(0.4, 0.8, h) * smooth(18, 14, h) * smooth(0.95, 0.8, sl) * (1 - rk) : 0
      const free = 1 - padW[i]
      mGrass[i] = Math.round(density[i] * 255); mSand[i] = Math.round(sandF * free * 255); mRock[i] = Math.round(rk * free * 255)
      mTree[i] = Math.round(tree * free * 255); mPalm[i] = Math.round(palm * free * 255); rockF[i] = rk * free
    }
  }
  // boulders gather at the foot of faces: rock nearby (box blur ~12 m) but not on the face itself
  const mBoulder = new Uint8Array(NN)
  {
    const rad = Math.max(1, Math.round(12 / texel)), tmpA = new Float32Array(NN), blur = new Float32Array(NN)
    for (let y = 0; y < R; y++) { let s = 0; for (let x = -rad; x <= rad; x++) s += rockF[y * R + clamp(x, 0, R - 1)]; for (let x = 0; x < R; x++) { tmpA[y * R + x] = s / (2 * rad + 1); s += rockF[y * R + Math.min(R - 1, x + rad + 1)] - rockF[y * R + Math.max(0, x - rad)] } }
    for (let x = 0; x < R; x++) { let s = 0; for (let y = -rad; y <= rad; y++) s += tmpA[clamp(y, 0, R - 1) * R + x]; for (let y = 0; y < R; y++) { blur[y * R + x] = s / (2 * rad + 1); s += tmpA[Math.min(R - 1, y + rad + 1) * R + x] - tmpA[Math.max(0, y - rad) * R + x] } }
    for (let i = 0; i < NN; i++) {
      const foot = smooth(0.08, 0.35, blur[i]) * (1 - smooth(0.3, 0.7, rockF[i])) * smooth(1.4, 0.6, slope[i]) * smooth(-1.5, -0.3, height[i])
      mBoulder[i] = Math.round(clamp(foot + 0.6 * bare[i] * smooth(-1.2, 0.2, height[i]), 0, 1) * (1 - padW[i]) * 255)
    }
  }
  mark('masks')

  // ---- textures
  const toHalf = THREE.DataUtils.toHalfFloat
  const hs = new Uint16Array(NN * 4), fl8 = new Uint8Array(NN * 4), mk8 = new Uint8Array(NN * 4)
  for (let i = 0; i < NN; i++) {
    hs[i * 4] = toHalf(height[i] + o.seaLevel); hs[i * 4 + 1] = toHalf(dShore[i]); hs[i * 4 + 2] = toHalf(slope[i]); hs[i * 4 + 3] = toHalf(density[i])
    fl8[i * 4] = flow[i] * 255; fl8[i * 4 + 1] = sediment[i] * 255; fl8[i * 4 + 2] = (concav[i] * 0.5 + 0.5) * 255; fl8[i * 4 + 3] = ao[i] * 255
    mk8[i * 4] = mGrass[i]; mk8[i * 4 + 1] = mTree[i]; mk8[i * 4 + 2] = mSand[i]; mk8[i * 4 + 3] = Math.round(bare[i] * 255)
  }
  const dataTex = (data, format, type, name) => {
    const t = new THREE.DataTexture(data, R, R, format, type)
    t.wrapS = t.wrapT = THREE.ClampToEdgeWrapping; t.magFilter = t.minFilter = THREE.LinearFilter
    t.generateMipmaps = false; t.name = name; t.needsUpdate = true
    return t
  }
  const heightTexture = dataTex(hs, THREE.RGBAFormat, THREE.HalfFloatType, 'terrain-height')
  const fieldsTex = dataTex(fl8, THREE.RGBAFormat, THREE.UnsignedByteType, 'terrain-fields')
  const masksTex = dataTex(mk8, THREE.RGBAFormat, THREE.UnsignedByteType, 'terrain-masks')
  const grassMask = dataTex(mGrass, THREE.RedFormat, THREE.UnsignedByteType, 'terrain-grass-mask')
  const treeMask = dataTex(mTree, THREE.RedFormat, THREE.UnsignedByteType, 'terrain-tree-mask')
  const sandMask = dataTex(mSand, THREE.RedFormat, THREE.UnsignedByteType, 'terrain-sand-mask')
  const padTex = dataTex(Uint8Array.from(padW, (v) => Math.round(v * 255)), THREE.RedFormat, THREE.UnsignedByteType, 'terrain-pads')
  const detail = getDetailTexture()
  mark('textures')

  // ---- the mesh: the R² map plus K telescoping apron rings per side, one regular grid topology, so
  // the analytic landscape runs on to the horizon without a crack
  const K = o.apron > 0 ? 16 : 0
  let grow = 1
  if (K) { let lo = 1.0001, hi = 3; for (let it = 0; it < 50; it++) { const g = (lo + hi) / 2, s = texel * g * (Math.pow(g, K) - 1) / (g - 1); if (s > o.apron) hi = g; else lo = g } grow = (lo + hi) / 2 }
  const C = R + 2 * K, xs = new Float64Array(C)
  for (let i = 0; i < R; i++) xs[K + i] = minX + (i + 0.5) * texel
  for (let k = 1, step = texel, acc = 0; k <= K; k++) { step *= grow; acc += step; xs[K - k] = minX + 0.5 * texel - acc; xs[K + R - 1 + k] = -minX - 0.5 * texel + acc }
  const vH = new Float32Array(C * C)
  for (let j = 0; j < C; j++) for (let i = 0; i < C; i++) {
    const ii = i - K, jj = j - K
    if (ii >= 0 && ii < R && jj >= 0 && jj < R) { vH[j * C + i] = height[jj * R + ii]; continue }
    const sx = i === 0 ? xs[1] - xs[0] : xs[i] - xs[i - 1], sz = j === 0 ? xs[1] - xs[0] : xs[j] - xs[j - 1]
    LOD = Math.max(sx, sz)
    preset.macro(xs[i], xs[j], tmp)
    vH[j * C + i] = post(xs[i], xs[j], tmp[0], tmp[1], tmp[2])
  }
  LOD = 0
  const pos = new Float32Array(C * C * 3), nrm = new Float32Array(C * C * 3)
  for (let j = 0; j < C; j++) for (let i = 0; i < C; i++) {
    const k = j * C + i, skirt = K && (i === 0 || j === 0 || i === C - 1 || j === C - 1) ? 80 : 0
    pos[k * 3] = xs[i]; pos[k * 3 + 1] = vH[k] + o.seaLevel - skirt; pos[k * 3 + 2] = xs[j]
    const i0 = i > 0 ? i - 1 : i, i1 = i < C - 1 ? i + 1 : i, j0 = j > 0 ? j - 1 : j, j1 = j < C - 1 ? j + 1 : j
    const gx = (vH[j * C + i1] - vH[j * C + i0]) / (xs[i1] - xs[i0]), gz = (vH[j1 * C + i] - vH[j0 * C + i]) / (xs[j1] - xs[j0])
    const l = 1 / Math.sqrt(gx * gx + 1 + gz * gz)
    nrm[k * 3] = -gx * l; nrm[k * 3 + 1] = l; nrm[k * 3 + 2] = -gz * l
  }
  // each quad split along the diagonal whose ends are closest in height: ridges and channels follow
  // the triangles instead of zig-zagging across them
  const diag = new Uint8Array((C - 1) * (C - 1)), index = new Uint32Array((C - 1) * (C - 1) * 6)
  for (let j = 0, p = 0; j < C - 1; j++) for (let i = 0; i < C - 1; i++) {
    const a = j * C + i, b = a + 1, c = a + C, d = c + 1
    const q = Math.abs(vH[a] - vH[d]) < Math.abs(vH[b] - vH[c]) ? 1 : 0
    diag[j * (C - 1) + i] = q
    if (q) { index[p++] = a; index[p++] = c; index[p++] = d; index[p++] = a; index[p++] = d; index[p++] = b }
    else { index[p++] = a; index[p++] = c; index[p++] = b; index[p++] = b; index[p++] = c; index[p++] = d }
  }
  const geometry = new THREE.BufferGeometry()
  geometry.setAttribute('position', new THREE.BufferAttribute(pos, 3))
  geometry.setAttribute('normal', new THREE.BufferAttribute(nrm, 3))
  geometry.setIndex(new THREE.BufferAttribute(index, 1))
  geometry.computeBoundingSphere(); geometry.computeBoundingBox()
  mark('mesh')

  // ---- CPU samplers (match the triangles for height, bilinear for the rest)
  const cellOf = (v) => {
    if (v <= xs[0]) return [0, 0]
    if (v >= xs[C - 1]) return [C - 2, 1]
    let i = Math.floor((v - minX) / texel - 0.5) + K
    if (i < K || i >= K + R - 1) { let lo = 0, hi = C - 1; while (hi - lo > 1) { const m = (lo + hi) >> 1; if (xs[m] <= v) lo = m; else hi = m } i = lo }
    return [i, (v - xs[i]) / (xs[i + 1] - xs[i])]
  }
  const heightAt = (x, z) => {
    if (x < xs[0] || x > xs[C - 1] || z < xs[0] || z > xs[C - 1]) { LOD = 0; preset.macro(x, z, tmp); return post(x, z, tmp[0], tmp[1], tmp[2]) + o.seaLevel }
    const [i, fx] = cellOf(x), [j, fz] = cellOf(z)
    const a = vH[j * C + i], b = vH[j * C + i + 1], c = vH[(j + 1) * C + i], d = vH[(j + 1) * C + i + 1]
    let h
    if (diag[j * (C - 1) + i]) h = fx >= fz ? a + (b - a) * fx + (d - b) * fz : a + (c - a) * fz + (d - c) * fx
    else h = fx + fz <= 1 ? a + (b - a) * fx + (c - a) * fz : d + (c - d) * (1 - fx) + (b - d) * (1 - fz)
    return h + o.seaLevel
  }
  const bil = (arr, x, z, outside = 0) => {
    const gx = (x - minX) / texel - 0.5, gz = (z - minZ) / texel - 0.5
    if (gx < -0.5 || gz < -0.5 || gx > R - 0.5 || gz > R - 0.5) return outside
    const x0 = clamp(Math.floor(gx), 0, R - 1), z0 = clamp(Math.floor(gz), 0, R - 1), x1 = Math.min(R - 1, x0 + 1), z1 = Math.min(R - 1, z0 + 1)
    const tx = clamp(gx - x0, 0, 1), tz = clamp(gz - z0, 0, 1)
    const a = arr[z0 * R + x0], b = arr[z0 * R + x1], c = arr[z1 * R + x0], d = arr[z1 * R + x1]
    return (a + (b - a) * tx) * (1 - tz) + (c + (d - c) * tx) * tz
  }
  const normalAt = (x, z, target = new THREE.Vector3()) => {
    const e = texel * 0.75
    return target.set(heightAt(x - e, z) - heightAt(x + e, z), 2 * e, heightAt(x, z - e) - heightAt(x, z + e)).normalize()
  }
  const slopeAt = (x, z) => { const e = texel * 0.75; return Math.hypot(heightAt(x + e, z) - heightAt(x - e, z), heightAt(x, z + e) - heightAt(x, z - e)) / (2 * e) }
  const u8 = (arr) => (x, z) => bil(arr, x, z, 0) / 255
  const masks = { grass: u8(mGrass), tree: u8(mTree), palm: u8(mPalm), sand: u8(mSand), rock: u8(mRock), boulder: u8(mBoulder) }
  const shoreAt = (x, z) => bil(dShore, x, z, heightAt(x, z) - o.seaLevel > 0 ? 5000 : -5000)

  // ---- terrain sun shadow: march every texel toward the sun over the heightfield, recording the
  // steepest skyline (world/erosion.js makeSunShadow, an angle test, not a height bias), on the CPU
  const SV = Math.min(R, 192), sunData = new Uint8Array(SV * SV).fill(255)
  const sunVis = new THREE.DataTexture(sunData, SV, SV, THREE.RedFormat, THREE.UnsignedByteType)
  sunVis.wrapS = sunVis.wrapT = THREE.ClampToEdgeWrapping; sunVis.magFilter = sunVis.minFilter = THREE.LinearFilter; sunVis.name = 'terrain-sun-shadow'; sunVis.needsUpdate = true
  const coarse = new Float32Array(SV * SV)
  for (let j = 0; j < SV; j++) for (let i = 0; i < SV; i++) coarse[j * SV + i] = bil(height, minX + (i + 0.5) * o.size / SV, minZ + (j + 0.5) * o.size / SV)
  const sunDirW = new THREE.Vector3(0, 1, 0)
  const bakeSun = (dir) => {
    const t0 = performance.now(), STEPS = 44, cell = o.size / SV
    const hl = Math.max(Math.hypot(dir.x, dir.z), 1e-3), bx = dir.x / hl, bz = dir.z / hl, climb = Math.max(dir.y, 0.009) / hl
    let start = cell * 1.2, g = 1.08
    { let lo = 1.0001, hi = 1.5; for (let it = 0; it < 40; it++) { const m = (lo + hi) / 2, s = start * m * (Math.pow(m, STEPS) - 1) / (m - 1); if (s > o.size * 1.2) hi = m; else lo = m } g = (lo + hi) / 2 }
    const ts = new Float32Array(STEPS)
    for (let s = 0, t = start, st = start; s < STEPS; s++) { ts[s] = t; st *= g; t += st }
    for (let j = 0; j < SV; j++) for (let i = 0; i < SV; i++) {
      const h0 = coarse[j * SV + i]
      let hor = -10
      for (let s = 0; s < STEPS; s++) {
        const t = ts[s], gx = i + bx * t / cell, gz = j + bz * t / cell
        if (gx < 0 || gz < 0 || gx > SV - 1 || gz > SV - 1) break
        const x0 = gx | 0, z0 = gz | 0, x1 = x0 < SV - 1 ? x0 + 1 : x0, z1 = z0 < SV - 1 ? z0 + 1 : z0, fx = gx - x0, fz = gz - z0
        const a = coarse[z0 * SV + x0], b = coarse[z0 * SV + x1], c = coarse[z1 * SV + x0], d = coarse[z1 * SV + x1]
        const hs2 = (a + (b - a) * fx) * (1 - fz) + (c + (d - c) * fx) * fz
        const m = (hs2 - h0) / t
        if (m > hor) hor = m
      }
      sunData[j * SV + i] = Math.round((1 - smooth(climb + 0.012, climb + 0.062, hor)) * 255)
    }
    sunVis.needsUpdate = true
    sunDirW.copy(dir)
    timings.sunBake = Math.round(performance.now() - t0)
  }

  // ---- material
  const meadow = new THREE.Color(0x4a7a30)
  const U0 = {
    uTerrDetail: { value: detail }, uHeightTex: { value: heightTexture }, uFields: { value: fieldsTex }, uMasks: { value: masksTex }, uSunVis: { value: sunVis }, uPads: { value: padTex },
    uBoundsMin: { value: new THREE.Vector2(minX, minZ) }, uBoundsSize: { value: new THREE.Vector2(o.size, o.size) },
    uRockSlope: { value: new THREE.Vector2(1.15, 2.0) }, uSeaLevel: { value: o.seaLevel }, uSandTop: { value: sandTop }, uTreeLine: { value: treeLine },
    uTime: { value: 6 }, uSwash: { value: o.swash ? 1 : 0 }, uUnderwater: { value: base.sea ? 1 : 0 }, uTexel: { value: 1 / R },
    uUnderBlades: { value: o.grassCover ? 0.5 : 0.92 }, uMeadowMix: { value: 0 }, uMeadowColor: { value: meadow }, uSunDirW: { value: sunDirW },
  }
  // reuse a previous terrain's material (opts.material) so editors that track material identity
  // (Edit3D's material catalogue) see one stable material across rebuilds
  let material, uniforms = U0
  const reuse = opts.material?.userData?.terrainUniforms
  if (reuse) { material = opts.material; for (const k in U0) { if (reuse[k]) reuse[k].value = U0[k].value; else reuse[k] = U0[k] } uniforms = reuse }
  else { material = makeTerrainMaterial(U0, `${o.name} ground`); material.userData.terrainUniforms = U0 }
  const mesh = new THREE.Mesh(geometry, material)
  mesh.name = o.name
  mesh.castShadow = true; mesh.receiveShadow = true
  mesh.frustumCulled = false

  let manualSun = false, light = null
  const lightDir = new THREE.Vector3(), tmpV = new THREE.Vector3()
  const maybeBake = (d) => { if (d.y > -0.05 && Math.abs(d.x - sunDirW.x) + Math.abs(d.y - sunDirW.y) + Math.abs(d.z - sunDirW.z) > 0.009) bakeSun(d) }
  mesh.onBeforeRender = (renderer, scene) => {
    if (manualSun) return
    if (!light || !light.parent) { light = null; scene.traverse((ob) => { if (!light && ob.isDirectionalLight && ob.visible) light = ob }) }
    if (!light) return
    light.updateMatrixWorld(); light.target.updateMatrixWorld()
    lightDir.setFromMatrixPosition(light.matrixWorld).sub(tmpV.setFromMatrixPosition(light.target.matrixWorld)).normalize()
    maybeBake(lightDir)
  }
  mark('material')
  timings.total = Math.round(performance.now() - T0)

  const scatter = ({ count = 100, mask = 'grass', minSpacing = 2, seed = 1, threshold = 0, area } = {}) => {
    const r = mulberry32(seed * 104729 + 7), fn = typeof mask === 'function' ? mask : masks[mask] ?? masks.grass
    const ax0 = area?.minX ?? minX, az0 = area?.minZ ?? minZ, ax1 = area?.maxX ?? -minX, az1 = area?.maxZ ?? -minZ
    const out = [], cellS = Math.max(minSpacing, 0.5), grid = new Map(), key = (gx, gz) => gx * 73856093 ^ gz * 19349663
    for (let tries = 0; out.length < count && tries < count * 60; tries++) {
      const x = ax0 + r() * (ax1 - ax0), z = az0 + r() * (az1 - az0), m = fn(x, z)
      if (m <= threshold || r() > m) continue
      const gx = Math.floor(x / cellS), gz = Math.floor(z / cellS)
      let ok = true
      for (let dz = -1; dz <= 1 && ok; dz++) for (let dx = -1; dx <= 1 && ok; dx++) {
        const l = grid.get(key(gx + dx, gz + dz)); if (l) for (const p of l) if ((p.x - x) ** 2 + (p.z - z) ** 2 < minSpacing * minSpacing) { ok = false; break }
      }
      if (!ok) continue
      const p = { x, y: heightAt(x, z), z, m }
      out.push(p); const k = key(gx, gz); if (!grid.has(k)) grid.set(k, []); grid.get(k).push(p)
    }
    return out
  }

  return {
    mesh, object: mesh, material, preset: presetName, options: o,
    seaLevel: o.seaLevel, sandTop: sandTop + o.seaLevel, treeLine: treeLine + o.seaLevel,
    bounds: { minX, minZ, maxX: -minX, maxZ: -minZ }, resolution: R,
    heightTexture, grassMask, treeMask, sandMask, masksTexture: masksTex, fieldsTexture: fieldsTex, detailTexture: detail, sunShadowTexture: sunVis,
    shoreGLSL: SHORE_GLSL, stacks: preset.stacks ?? [], pads,
    heightAt, normalAt, slopeAt, shoreAt,
    grassAt: masks.grass, treeAt: masks.tree, palmAt: masks.palm, sandAt: masks.sand, rockAt: masks.rock, boulderAt: masks.boulder,
    scatter,
    data: { res: R, height, slope, flow, sediment, density, dShore, bare, padW, masks: { grass: mGrass, tree: mTree, palm: mPalm, sand: mSand, rock: mRock, boulder: mBoulder } },
    timings,
    update(time) { uniforms.uTime.value = time },
    setSun(direction) { manualSun = true; maybeBake(tmpV.copy(direction).normalize()) },
    setMeadowColor(color, amount = 1) { meadow.set(color); uniforms.uMeadowMix.value = amount },
    dispose(keepMaterial = false) { geometry.dispose(); if (!keepMaterial) material.dispose(); for (const t of [heightTexture, fieldsTex, masksTex, grassMask, treeMask, sandMask, sunVis, padTex]) t.dispose() },
  }
}

// Rock material shared with ./rocks.js: the terrain's cliff shading on any mesh. Texture space is the
// object's own (per instance for an InstancedMesh), in metres, so it moves with the rock.
export function createRockMaterial({ name = 'Rock', moss = 0.3, color } = {}) {
  const material = new THREE.MeshStandardMaterial({ name, roughness: 0.85, metalness: 0 })
  const tint = new THREE.Color(color ?? 0xffffff)
  material.onBeforeCompile = (shader) => {
    shader.uniforms.uTerrDetail = { value: getDetailTexture() }
    shader.uniforms.uRockMoss = { value: moss }
    shader.uniforms.uRockTint = { value: tint }
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vRkP; varying vec3 vRkN; varying vec3 vRkR0; varying vec3 vRkR1; varying vec3 vRkR2; varying float vRkBase; varying float vRkSz;')
      .replace('#include <begin_vertex>', `#include <begin_vertex>
mat4 rkM = modelMatrix;
#ifdef USE_INSTANCING
rkM = modelMatrix * instanceMatrix;
#endif
vec3 rkS = vec3(length(rkM[0].xyz), length(rkM[1].xyz), length(rkM[2].xyz));
// texture scale follows the rock: below ~3.5 m the strata, joints and grit shrink with it (up to 3x), so
// a cobble carries a boulder's few beds instead of being cut by metre-scale contour rings
float rkSz = max(rkS.x, max(rkS.y, rkS.z));
vRkP = transformed * rkS * clamp(3.5 / max(rkSz, 1e-3), 1.0, 3.0) + floor(rkM[3].xyz) * 1.731;
vRkSz = rkSz;
vRkN = normalize(objectNormal / rkS);
vRkR0 = rkM[0].xyz / rkS.x; vRkR1 = rkM[1].xyz / rkS.y; vRkR2 = rkM[2].xyz / rkS.z;
vRkBase = transformed.y;`)
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>
uniform sampler2D uTerrDetail; uniform float uRockMoss; uniform vec3 uRockTint;
varying vec3 vRkP; varying vec3 vRkN; varying vec3 vRkR0; varying vec3 vRkR1; varying vec3 vRkR2; varying float vRkBase; varying float vRkSz;
${ROCK_GLSL}
vec3 rkNW; float rkAO;`)
      .replace('#include <color_fragment>', `
{
  vec3 nL;
  // partings, joints and grit normals are close-range detail: weaker on small rocks
  float nearR = tStep(160.0, 20.0, length(vViewPosition)) * mix(0.35, 0.8, tStep(0.6, 4.0, vRkSz));
  vec3 alb = terrRock(vRkP, normalize(vRkN), 0.0, nearR, nL);
  mat3 rot = mat3(vRkR0, vRkR1, vRkR2);
  rkNW = normalize(rot * nL);
  float mossW = tStep(0.55, 0.95, rkNW.y) * uRockMoss * tStep(0.35, 0.65, tDet(vRkP.xz / 3.3).w + 0.15);
  alb = mix(alb, ${lin(0.20, 0.25, 0.12)}, mossW);
  rkAO = mix(0.5, 1.0, tStep(0.0, 0.22, vRkBase));   // ground contact: the sunk base sits in its own shade
  diffuseColor.rgb = alb * uRockTint * mix(0.75, 1.0, rkAO);
#if defined( USE_COLOR ) || defined( USE_COLOR_ALPHA )
  diffuseColor.rgb *= vColor.rgb;   // per-instance tint
#endif
}`)
      .replace('#include <normal_fragment_maps>', 'normal = normalize((viewMatrix * vec4(rkNW, 0.0)).xyz);')
      .replace('#include <aomap_fragment>', '#include <aomap_fragment>\nreflectedLight.indirectDiffuse *= rkAO; reflectedLight.indirectSpecular *= rkAO;')
  }
  material.customProgramCacheKey = () => 'terrain-rock-v2'
  return material
}

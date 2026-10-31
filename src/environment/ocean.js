// Ocean: spectral FFT sea (JONSWAP·TMA wind sea + distant swell, Donelan-Banner spreading) in
// 3 cascades, reaching the true horizon, with Jacobian whitecaps, Beer-Lambert depth colour,
// crest subsurface glow, sky reflection + sun glitter (scene.environment + DirectionalLight),
// distance antialiasing, and an optional seabed for shoaling, surf, swash and shallow colour.
// One mesh, one draw. Built on MeshPhysicalMaterial + onBeforeCompile, so fog, log depth,
// environment and lights work as for any built-in material. Time is absolute: same t -> same sea.
//
//   const ocean = createOcean({ windSpeed: 9, windDirection: 30 })      // open sea
//   scene.add(ocean.mesh); excludeFromFraming(ocean.mesh); ocean.update(12)
//   asset.registerAnimation('sea', { name: 'Sea', objectId: 'ocean', duration: 60,
//     sample: (t) => ocean.update(12 + t) })                          // Play: update(elapsed)
//   createOcean({ seabed: terrain })    // terrain.heightTexture + bounds (or { heightAt, bounds })
//   createOcean({ mode: 'calm', size: [120, 80], center: [0, 0], seabed })   // pond/pool/bay
//   buoy.position.y = ocean.heightAt(x, z)                             // floating objects
//
// Parameters (all optional; ocean.setWaves({...}) changes them live):
//   windSpeed 9 m/s (1-25: sets wave length AND height), windDirection 45 deg (0 = waves run
//   toward +X, 90 = toward +Z), waveScale 1 (0-3 height multiplier), choppiness 1.3 (0-2.5,
//   sharper crests + more foam), foam 1 (0-3), swell 1 (0-3, distant 280 m rollers),
//   swellDirection = windDirection + 25, fetch 100 km, depth 500 m, seaLevel 0, seed 1.
//   Look: deepColor, scatterColor, foamColor, seabedColor, absorb [r,g,b] 1/m.
//   mode 'calm' = lake/pool: light breeze ripples, no whitecaps, near-mirror, the floor shows
//   through (seeThrough). Calm water under 30 m (a pool) defaults to windSpeed 2, waveScale 0.12,
//   swash 0. A pool: build the shell, then createOcean({ mode: 'calm', size: [10, 4],
//   center: [x, z], seaLevel: copingY - 0.05, seabed: { heightAt: floorAt, bounds } }).
//   size [w, d] + center [x, z] = finite water plane (pool, pond); default is boundless,
//   following the camera out to 60 km. seabed: terrain object ({ heightTexture, bounds,
//   seaLevel, shoreGLSL }) or { heightAt | depthAt, bounds } (baked here, 256^2).
//   sun: a DirectionalLight to follow; else setSun(dirTowardSun, colorTimesIntensity); else
//   the first DirectionalLight in the scene is used automatically.
// Cost (M-series, measured in Chromium): 1 draw, 181,504 triangles (boundless), update(t) CPU
//   3.7 ms ocean (free when t repeats), build ~27-33 ms, 6 float textures (128^2 x4, 64^2 x2).
// Ported from Kimi's world-building template (WebGPU/TSL) to WebGL for Edit3D.
import * as THREE from 'three'

const G = 9.81
const DEEP = 140 // metres of water assumed where no seabed is bound

// The shared shoreline model (world/shore.js), verbatim from the terrain module so the sand's
// wet band and the sea's swash sheet run one function. Keep identical to terrain.js SHORE_GLSL.
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

// ------------------------------------------------------------------ CPU: noise, FFT, spectrum

function mulberry32(seed) {
  let s = seed >>> 0
  return () => {
    s |= 0; s = (s + 0x6D2B79F5) | 0
    let t = Math.imul(s ^ (s >>> 15), 1 | s)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

// In-place 2D inverse FFT (e^{+i}, unnormalised) over separate re/im arrays: radix-4 DIT on
// bit-reversed input, with one radix-2 stage first when log2(n) is odd. ~0.17 ms per 128^2.
export function makeFFT2D(n) {
  const bits = Math.log2(n), rev = new Uint16Array(n)
  for (let i = 0; i < n; i++) { let r = 0; for (let b = 0; b < bits; b++) r |= ((i >> b) & 1) << (bits - 1 - b); rev[i] = r }
  const cs = new Float64Array(n), sn = new Float64Array(n)
  for (let i = 0; i < n; i++) { cs[i] = Math.cos(2 * Math.PI * i / n); sn[i] = Math.sin(2 * Math.PI * i / n) }
  const tr = new Float64Array(n), ti = new Float64Array(n), odd = bits & 1
  function line(re, im, off, stride) {
    for (let i = 0; i < n; i++) { const o = off + rev[i] * stride; tr[i] = re[o]; ti[i] = im[o] }
    let q = 1
    if (odd) {
      for (let a = 0; a < n; a += 2) { const xr = tr[a + 1], xi = ti[a + 1]; tr[a + 1] = tr[a] - xr; ti[a + 1] = ti[a] - xi; tr[a] += xr; ti[a] += xi }
      q = 2
    }
    for (; q < n; q <<= 2) {
      const L = q * 4, step = n / L
      for (let k = 0; k < q; k++) {
        const w1r = cs[k * step], w1i = sn[k * step], w2r = cs[2 * k * step], w2i = sn[2 * k * step]
        for (let a = k; a < n; a += L) {
          const i1 = a + q, i2 = a + 2 * q, i3 = a + 3 * q
          const b1r = tr[i1] * w2r - ti[i1] * w2i, b1i = tr[i1] * w2i + ti[i1] * w2r
          const b3r = tr[i3] * w2r - ti[i3] * w2i, b3i = tr[i3] * w2i + ti[i3] * w2r
          const e0r = tr[a] + b1r, e0i = ti[a] + b1i, e1r = tr[a] - b1r, e1i = ti[a] - b1i
          const o0r = tr[i2] + b3r, o0i = ti[i2] + b3i, o1r = tr[i2] - b3r, o1i = ti[i2] - b3i
          const t0r = o0r * w1r - o0i * w1i, t0i = o0r * w1i + o0i * w1r
          const t1r = -(o1r * w1i + o1i * w1r), t1i = o1r * w1r - o1i * w1i
          tr[a] = e0r + t0r; ti[a] = e0i + t0i; tr[i2] = e0r - t0r; ti[i2] = e0i - t0i
          tr[i1] = e1r + t1r; ti[i1] = e1i + t1i; tr[i3] = e1r - t1r; ti[i3] = e1i - t1i
        }
      }
    }
    for (let i = 0; i < n; i++) { const o = off + i * stride; re[o] = tr[i]; im[o] = ti[i] }
  }
  return (re, im) => {
    for (let r = 0; r < n; r++) line(re, im, r * n, 1)
    for (let c = 0; c < n; c++) line(re, im, c, n)
  }
}

const jonswapAlpha = (fetch, U) => 0.076 * Math.pow(G * fetch / (U * U), -0.22)
const jonswapPeakOmega = (fetch, U) => 22 * Math.pow(U * fetch / (G * G), -0.33)
function tmaCorrection(omega, depth) {
  const wh = omega * Math.sqrt(depth / G)
  return wh < 1 ? 0.5 * wh * wh : wh < 2 ? 1 - 0.5 * (2 - wh) * (2 - wh) : 1
}
function dbNorm(s) { // Donelan-Banner normalisation, quartic fits switching at s = 5
  const s2 = s * s, s3 = s2 * s, s4 = s3 * s
  return s < 5 ? -5.64e-4 * s4 + 7.76e-3 * s3 - 4.4e-2 * s2 + 0.192 * s + 0.163 : -4.8e-8 * s4 + 1.07e-5 * s3 - 9.53e-4 * s2 + 5.9e-2 * s + 0.393
}
function layerS(omega, theta, depth, Ly) { // JONSWAP·TMA·spreading for one layer
  const wp = Ly.peakOmega, sigma = omega < wp ? 0.07 : 0.09, dw = omega - wp
  const r = Math.exp(-dw * dw / (2 * sigma * sigma * wp * wp))
  const S = Ly.alpha * G * G * Math.pow(omega, -5) * Math.exp(-1.25 * Math.pow(wp / omega, 4)) * Math.pow(Ly.gamma, r) * tmaCorrection(omega, depth)
  const ratio = omega / wp
  const sp = ratio < 1 ? 6.97 * Math.pow(ratio, 5) : 9.77 * Math.pow(ratio, -2.5)
  const s = Math.min(Math.max(sp + Math.tanh(Math.min(ratio, 20)) * 16 * Ly.swell * Ly.swell, 0), 60)
  const powered = dbNorm(s) * Math.pow(Math.max(Math.abs(Math.cos((theta - Ly.dir) * 0.5)), 1e-5), 2 * s)
  const c = Math.cos(theta - Ly.dir), base = (2 / Math.PI) * c * c
  return S * (base + (powered - base) * Ly.spreadBlend) * Ly.scale
}
function makeLayer(scale, U, dirDeg, fetch, spreadBlend, swell) {
  return { scale, alpha: jonswapAlpha(fetch, U), peakOmega: jonswapPeakOmega(fetch, U), gamma: 3.3, spreadBlend, swell, dir: dirDeg * Math.PI / 180, fade: 0.01 }
}

// small tileable noise (sums of integer-frequency sines), shared by every ocean instance
let noiseTex = null
function detailNoise() {
  if (noiseTex) return noiseTex
  const size = 128, data = new Uint8Array(size * size * 4)
  let seed = 7
  const rand = () => (seed = (seed * 16807) % 2147483647) / 2147483647
  const waves = []
  for (let ch = 0; ch < 4; ch++) for (let i = 0; i < 10; i++) waves.push({ ch, fx: Math.round(1 + rand() * 5) * (rand() > 0.5 ? 1 : -1), fy: Math.round(1 + rand() * 5) * (rand() > 0.5 ? 1 : -1), ph: rand() * Math.PI * 2, amp: 0.5 + rand() })
  const acc = new Float32Array(size * size * 4), norm = [0, 0, 0, 0]
  for (const w of waves) {
    norm[w.ch] += w.amp
    const sx = new Float32Array(size), cx = new Float32Array(size)
    for (let x = 0; x < size; x++) { sx[x] = Math.sin(2 * Math.PI * w.fx * x / size); cx[x] = Math.cos(2 * Math.PI * w.fx * x / size) }
    for (let y = 0; y < size; y++) {
      const a = 2 * Math.PI * w.fy * y / size + w.ph, sa = Math.sin(a) * w.amp, ca = Math.cos(a) * w.amp
      for (let x = 0; x < size; x++) acc[(y * size + x) * 4 + w.ch] += sx[x] * ca + cx[x] * sa
    }
  }
  for (let i = 0; i < acc.length; i++) data[i] = Math.round((acc[i] / norm[i & 3] * 0.5 + 0.5) * 255)
  noiseTex = new THREE.DataTexture(data, size, size, THREE.RGBAFormat)
  noiseTex.wrapS = noiseTex.wrapT = THREE.RepeatWrapping
  noiseTex.magFilter = THREE.LinearFilter; noiseTex.minFilter = THREE.LinearMipmapLinearFilter
  noiseTex.generateMipmaps = true; noiseTex.anisotropy = 4; noiseTex.needsUpdate = true
  return noiseTex
}

function floatTex(data, n, mips) {
  const t = new THREE.DataTexture(data, n, n, THREE.RGBAFormat, THREE.FloatType)
  t.wrapS = t.wrapT = THREE.RepeatWrapping
  t.magFilter = THREE.LinearFilter
  t.minFilter = mips ? THREE.LinearMipmapLinearFilter : THREE.LinearFilter
  t.generateMipmaps = mips; t.anisotropy = mips ? 8 : 1
  t.needsUpdate = true
  return t
}

// Seabed bake for { heightAt | depthAt, bounds }: R = ground height (world y), G = signed shore
// distance (m, + inland), the same layout the terrain module's heightTexture uses.
function bakeSeabed(fn, bounds, seaLevel, res = 256) {
  const { minX, minZ, maxX, maxZ } = bounds, data = new Float32Array(res * res * 4)
  const land = new Uint8Array(res * res), dx = (maxX - minX) / (res - 1), dz = (maxZ - minZ) / (res - 1)
  for (let j = 0; j < res; j++) for (let i = 0; i < res; i++) {
    const h = fn(minX + i * dx, minZ + j * dz), o = j * res + i
    data[o * 4] = h; land[o] = h > seaLevel ? 1 : 0
  }
  // two-pass chamfer distance to the nearest cell of the other kind, signed + on land
  const d = new Float32Array(res * res), BIG = 1e9, a = Math.min(dx, dz), b = Math.hypot(dx, dz)
  for (let o = 0; o < d.length; o++) {
    const i = o % res, j = (o / res) | 0, l = land[o]
    const edge = (i > 0 && land[o - 1] !== l) || (i < res - 1 && land[o + 1] !== l) || (j > 0 && land[o - res] !== l) || (j < res - 1 && land[o + res] !== l)
    d[o] = edge ? a * 0.5 : BIG
  }
  for (let j = 0; j < res; j++) for (let i = 0; i < res; i++) {
    const o = j * res + i; let v = d[o]
    if (i > 0) v = Math.min(v, d[o - 1] + dx)
    if (j > 0) { v = Math.min(v, d[o - res] + dz); if (i > 0) v = Math.min(v, d[o - res - 1] + b); if (i < res - 1) v = Math.min(v, d[o - res + 1] + b) }
    d[o] = v
  }
  for (let j = res - 1; j >= 0; j--) for (let i = res - 1; i >= 0; i--) {
    const o = j * res + i; let v = d[o]
    if (i < res - 1) v = Math.min(v, d[o + 1] + dx)
    if (j < res - 1) { v = Math.min(v, d[o + res] + dz); if (i < res - 1) v = Math.min(v, d[o + res + 1] + b); if (i > 0) v = Math.min(v, d[o + res - 1] + b) }
    d[o] = v
  }
  for (let o = 0; o < d.length; o++) data[o * 4 + 1] = land[o] ? d[o] : -d[o]
  const t = new THREE.DataTexture(data, res, res, THREE.RGBAFormat, THREE.FloatType)
  t.wrapS = t.wrapT = THREE.ClampToEdgeWrapping
  t.magFilter = t.minFilter = THREE.LinearFilter; t.generateMipmaps = false; t.needsUpdate = true
  // texel centres sit on the grid samples, like the terrain module's bake
  return { texture: t, data, res, bounds: { minX: minX - dx / 2, minZ: minZ - dz / 2, maxX: maxX + dx / 2, maxZ: maxZ + dz / 2 } }
}

// ------------------------------------------------------------------ shader

const DECL = /* glsl */`
uniform sampler2D oDisp0; uniform sampler2D oDisp1; uniform sampler2D oDisp2;
uniform vec3 oL; uniform vec3 oTexel; uniform vec3 oOn;
uniform float oTime; uniform float oSeaLevel; uniform float oSwash;
uniform sampler2D oBed; uniform vec4 oBedRect; uniform float oBedMix;
varying vec2 vOXZ; varying vec3 vOWorld;
${SHORE_GLSL}
// 1 inside the seabed rectangle (fading over its last 3%), times the seabed switch
float oBedIn( vec2 uv ) { vec2 e = min( uv, 1.0 - uv ); return shoreStep( 0.0, 0.03, min( e.x, e.y ) ) * oBedMix; }
`

const VERT_DECL = /* glsl */`
uniform float oCellK; uniform float oCellMin; uniform float oFar;
`

// displacement: 3 cascades (mip level = mesh cell size, so geometry never aliases), shoaling,
// forward pitch, cnoidal trough limit, swash sheet and its lip (see ocean/README.md)
const VERT_BODY = /* glsl */`
vec3 transformed = vec3( position );
vec2 oXZ = ( modelMatrix * vec4( position, 1.0 ) ).xz;
float oCell = max( length( position.xz ) * oCellK, oCellMin );
vec3 oD = vec3( 0.0 );
oD += oOn.x * textureLod( oDisp0, oXZ / oL.x, max( log2( oCell / oTexel.x ) - 0.5, 0.0 ) ).xyz;
oD += oOn.y * textureLod( oDisp1, oXZ / oL.y, max( log2( oCell / oTexel.y ) - 0.5, 0.0 ) ).xyz;
oD += oOn.z * textureLod( oDisp2, oXZ / oL.z, max( log2( oCell / oTexel.z ) - 0.5, 0.0 ) ).xyz;
float oGeo = 1.0, oSurge = 0.0, oStill = 1e4, oPitchK = 0.0;
vec2 oPitch = vec2( 0.0 );
#ifdef OCEAN_SEABED
  vec2 oUV = ( oXZ - oBedRect.xy ) * oBedRect.zw;
  vec2 oHD = textureLod( oBed, oUV, 0.0 ).xy;
  float oBedH = oHD.x - oSeaLevel;
  float oSD = max( -oBedH, 0.0 );
  float oIn = oBedIn( oUV );
  // Green's-law gain on the way in, collapse over the last couple of metres
  oGeo = mix( 1.0, ( 1.0 + 0.55 * shoreStep( 17.0, 3.5, oSD ) ) * shoreStep( 0.25, 2.6, oSD ), oIn );
  oStill = mix( 1e4, oSD, oIn );
  vec2 oEx = vec2( 4.0 * oBedRect.z, 0.0 ), oEz = vec2( 0.0, 4.0 * oBedRect.w );
  vec2 oUp = vec2( textureLod( oBed, oUV + oEx, 0.0 ).x - textureLod( oBed, oUV - oEx, 0.0 ).x,
                   textureLod( oBed, oUV + oEz, 0.0 ).x - textureLod( oBed, oUV - oEz, 0.0 ).x );
  oPitch = oUp / max( length( oUp ), 1e-4 );
  oPitchK = shoreStep( 11.0, 1.2, oSD ) * oIn * 0.55;
  oSurge = shoreSample( oXZ, oBedH, oHD.y, oTime ).x * oIn * oSwash;
#endif
float oDy = oD.y * oGeo;
float oRoom = oStill * 0.62 + 0.04;
float oPos = max( oDy, 0.0 );
float oFlat = oPos + oRoom * ( exp( ( oDy - oPos ) / oRoom ) - 1.0 );
float oY = mix( oDy, oFlat, shoreStep( 9.0, 0.4, oStill ) ) + oSurge;
#ifdef OCEAN_SEABED
  oY += shoreLip( oY - oBedH ) * oIn;
#endif
float oLean = max( oY, 0.0 ) * oPitchK;
transformed.x += oD.x * oGeo + oPitch.x * oLean;
transformed.y += oY;
transformed.z += oD.z * oGeo + oPitch.y * oLean;
vOXZ = oXZ;
vOWorld = ( modelMatrix * vec4( transformed, 1.0 ) ).xyz;
`

// The sea reaches the horizon: vertices past camera.far are pulled in along their own view ray
// (same pixel, depth inside the frustum). mvPosition stays true for fog and lighting.
const VERT_PROJECT = /* glsl */`
vec4 mvPosition = modelViewMatrix * vec4( transformed, 1.0 );
vec4 oMv = mvPosition;
if ( oFar > 0.0 ) oMv.xyz *= min( 1.0, oFar / length( oMv.xyz ) );
gl_Position = projectionMatrix * oMv;
`

const FRAG_DECL = /* glsl */`
uniform sampler2D oDer0; uniform sampler2D oDer1; uniform sampler2D oDer2; uniform sampler2D oNoise;
uniform vec3 oScatter; uniform vec3 oFoamCol; uniform vec3 oBedColor; uniform vec3 oAbsorb;
uniform vec3 oSunDir; uniform vec3 oSunCol;
uniform float oDetail; uniform float oSSS; uniform float oCaustics; uniform float oPxPerM;
uniform float oBodyGain; uniform float oRoughFar; uniform float oFlatten; uniform float oFoamAmt;
uniform vec3 oSlopeVar; uniform vec3 oBandMin; uniform vec2 oWind; uniform float oShoreFoamK;
`

const FRAG_NORMAL = /* glsl */`
float faceDirection = gl_FrontFacing ? 1.0 : - 1.0;
vec3 oPosW = vOWorld;
vec3 oToCam = cameraPosition - oPosW;
float oDist = length( oToCam );
vec3 oV = oToCam / max( oDist, 1e-3 );
float oPx = oDist * oPxPerM;   // metres per pixel at this range
vec2 oUV0 = vOXZ / oL.x, oUV1 = vOXZ / oL.y, oUV2 = vOXZ / oL.z;
// slopes + fold terms; each band fades once its longest wave (L/6) stops covering pixels,
// on top of the mip/anisotropic filtering, so ripples go first and the swell reaches the horizon
vec3 oFade = vec3( shoreStep( oL.x / 12.0, oL.x / 60.0, oPx ), shoreStep( oL.y / 12.0, oL.y / 60.0, oPx ), shoreStep( oL.z / 12.0, oL.z / 60.0, oPx ) );
vec4 oDer = oOn.x * texture2D( oDer0, oUV0 ) * oFade.x
          + oOn.y * texture2D( oDer1, oUV1 ) * oFade.y
          + oOn.z * texture2D( oDer2, oUV2 ) * oFade.z;
// specular AA: slope variance the pixel can no longer resolve (faded bands + what the mip
// filter averages away, with the footprint stretched at grazing view) widens the GGX lobe,
// so far water reads as smooth glitter streaks instead of white grain
float oPxA = oPx / max( sqrt( abs( oV.y ) ), 0.5 );
vec3 oResolved = oFade * ( 1.0 - vec3( shoreStep( oBandMin.x * 0.3, oBandMin.x * 3.0, oPxA ),
    shoreStep( oBandMin.y * 0.3, oBandMin.y * 3.0, oPxA ), shoreStep( oBandMin.z * 0.3, oBandMin.z * 3.0, oPxA ) ) );
float oLost = 0.5 * dot( oSlopeVar * oOn, 1.0 - oResolved );
float oCarve = shoreStep( 0.5, 0.08, oPxA ); // sub-texel foam carving only where it is resolved
// whitecaps: the persistent Jacobian of the two long bands, thresholded per pixel (not per texel)
// (the threshold wanders with a drifting noise so a cap's outline is ragged, not the texel grid)
vec4 oFN = texture2D( oNoise, vOXZ * 0.31 + oTime * vec2( 0.009, -0.012 ) );
float oWob = ( oFN.x * 0.6 + oFN.y * 0.4 - 0.5 ) * 0.34 * oCarve;
// the 100 m band's caps are a metre or two across: gone once a pixel covers them
float oTurb = oOn.x * clamp( ( 0.4 + oWob - texture2D( oDisp0, oUV0 ).w ) * 2.5, 0.0, 1.0 )
            + oOn.y * clamp( ( 0.4 + oWob - texture2D( oDisp1, oUV1 ).w ) * 2.5, 0.0, 1.0 ) * shoreStep( 0.9, 0.25, oPxA );
oTurb *= oFoamAmt;
float oSX = oDer.x / max( 1.0 + oDer.z, 0.2 );
float oSZ = oDer.y / max( 1.0 + oDer.w, 0.2 );
// sub-grid detail: one baked noise, two drifting scales, gone where it would only shimmer
float oNear = shoreStep( 900.0, 90.0, oDist ) * shoreStep( 0.35, 0.06, oPxA );
oLost += oDetail * oDetail * 0.2 * ( 1.0 - oNear );
vec4 oN1 = texture2D( oNoise, vOXZ * 0.06 + oTime * vec2( 0.014, 0.011 ) );
vec4 oN2 = texture2D( oNoise, vOXZ * 0.17 + oTime * vec2( -0.021, 0.017 ) );
oSX += ( oN1.x + oN2.x - 1.0 ) * oDetail * oNear;
oSZ += ( oN1.y + oN2.y - 1.0 ) * oDetail * oNear;
vec3 oN = normalize( vec3( -oSX, 1.0, -oSZ ) );
oN = normalize( mix( oN, vec3( 0.0, 1.0, 0.0 ), clamp( sqrt( oDist / 2600.0 ) * 0.55, 0.0, oFlatten ) ) );

// water column: clamped for the optics, signed for deciding where the sea stops
float oDepth = ${DEEP.toFixed(1)}, oColumn = ${DEEP.toFixed(1)}, oShoreK = 0.0;
vec2 oBedHD = vec2( 0.0, 1e4 );
#ifdef OCEAN_SEABED
  vec2 oBUV = ( oPosW.xz - oBedRect.xy ) * oBedRect.zw;
  vec2 oHDf = texture2D( oBed, oBUV ).xy;
  oShoreK = oBedIn( oBUV );
  oBedHD = vec2( oHDf.x - oSeaLevel, oHDf.y );
  oColumn = mix( ${DEEP.toFixed(1)}, oPosW.y - oHDf.x, oShoreK );
  oDepth = max( oColumn, 0.0 );
#endif

// downwelling light on a level surface, from whatever lights + environment the scene has
vec3 oUpV = normalize( ( viewMatrix * vec4( 0.0, 1.0, 0.0, 0.0 ) ).xyz );
vec3 oSkyE = getAmbientLightIrradiance( ambientLightColor );
#if NUM_HEMI_LIGHTS > 0
  for ( int i = 0; i < NUM_HEMI_LIGHTS; i ++ ) oSkyE += getHemisphereLightIrradiance( hemisphereLights[ i ], oUpV );
#endif
#if defined( USE_ENVMAP ) && defined( ENVMAP_TYPE_CUBE_UV )
  oSkyE += getIBLIrradiance( oUpV );
#endif
vec3 oE = ( oSkyE + oSunCol * max( oSunDir.y, 0.0 ) ) * RECIPROCAL_PI;

// Beer-Lambert down the column and back up the (slanted) view path
float oPath = oDepth * ( 1.0 + 1.0 / max( abs( oV.y ), 0.22 ) );
vec3 oTrans = exp( -oAbsorb * oPath );
vec2 oBedUV = oPosW.xz + oN.xz * oDepth * 0.5;
float oBedN = texture2D( oNoise, oBedUV * 0.055 ).x * 0.55 + texture2D( oNoise, oBedUV * 0.21 ).y * 0.45;
// caustics for free: horizontal compression of the wave field is where refracted sun converges
float oFocus = max( 1.0 - ( oDer.z + oDer.w ) * 2.6, 0.0 );
float oCaus = clamp( oFocus * oFocus * oFocus - 0.9, -0.3, 1.6 ) * oCaustics * shoreStep( 14.0, 1.0, oDepth ) * max( oSunDir.y, 0.0 );
vec3 oBedLit = oBedColor * ( oBedN * 0.5 + 0.7 ) * ( 1.0 + oCaus ) * oE;
vec3 oVolume = mix( diffuse, oScatter, exp( -oDepth / 7.0 ) ) * ( 1.0 - oTrans );
#ifdef OCEAN_SEETHROUGH
  vec3 oBody = oVolume * oE * oBodyGain;   // the floor itself is the geometry behind, seen through
#else
  vec3 oBody = oBedLit * oTrans + oVolume * oE * oBodyGain;
#endif
// crest scatter: refracted view ray toward the sun, plus a height gate (crests glow, troughs dark)
vec3 oRF = refract( -oV, oN, 0.75 );
float oThrough = pow( max( dot( oRF, oSunDir ), 0.0 ), 14.0 ) * smoothstep( -0.02, 0.25, oSunDir.y );
float oRel = oPosW.y - oSeaLevel;
float oCrest = clamp( oRel * 0.42 + 0.38, 0.0, 1.0 );
oBody += vec3( 0.28, 0.62, 0.55 ) * oSunCol * RECIPROCAL_PI * ( oThrough * oSSS * 1.8 + oCrest * 0.025 ) * oBodyGain;
float oFres = 0.02 + 0.98 * pow( 1.0 - max( dot( oN, oV ), 0.0 ), 5.0 );

// foam: persistent Jacobian whitecaps (baked on the CPU), depth-limited breakers, lace, swash
// whitecaps: drawn out downwind into streaks and holed into broken patches (only where a
// pixel resolves it), translucent like the original's
vec2 oWp = vec2( -oWind.y, oWind.x );
vec2 oSC = vec2( dot( vOXZ, oWind ) * 0.03, dot( vOXZ, oWp ) * 0.22 ) + oTime * vec2( 0.006, 0.0 );
float oStreak = texture2D( oNoise, oSC ).x * 0.65 + texture2D( oNoise, oSC * 2.3 + 0.37 ).y * 0.35;
float oCov = smoothstep( 0.15, 1.6, oTurb * mix( 1.0, 0.3 + 1.5 * oStreak, oCarve ) );
oCov *= mix( 1.0, smoothstep( 0.28, 0.6, oFN.w * 0.75 + oStreak * 0.25 + oCov * 0.3 ), oCarve );
oCov *= 0.8 * mix( 0.5, 1.0, oFN.z );
float oSheet = smoothstep( 0.35, 0.72, oN2.x * 0.6 + oN1.y * 0.4 );
float oSteep = ( oRel + 0.3 ) / max( oDepth, 0.35 );
float oSurf = smoothstep( 0.30, 0.85, oSteep ) * shoreStep( 7.0, 0.5, oDepth ) * mix( 0.5, 1.0, oN1.w * 0.5 + oN2.z * 0.5 );
float oLace = smoothstep( 0.10, 0.48, oSteep ) * shoreStep( 2.6, 0.05, oDepth ) * smoothstep( -0.02, 0.07, oColumn )
            * smoothstep( 0.34, 0.78, oN2.w ) * 0.55;
oCov = clamp( max( oCov, max( oSurf, oLace ) * oShoreFoamK ), 0.0, 1.0 ) * mix( 1.0, 0.5, smoothstep( 350.0, 2200.0, oDist ) );
oCov *= mix( oSheet, 1.0, smoothstep( 0.05, 0.45, oDepth ) );
float oShoreFoam = 0.0, oEdge = oColumn;
#ifdef OCEAN_SEABED
  vec4 oSw = shoreSample( oPosW.xz, oBedHD.x, oBedHD.y, oTime );
  oEdge -= oSw.w * oShoreK;
  oShoreFoam = shoreFoam( oSw.y * oSwash, oEdge ) * oShoreK * oSheet * oShoreFoamK;
  oCov = max( oCov, oShoreFoam );
#endif
float oFoamN = mix( 0.55, 0.9, oN1.z * 0.5 + oN2.w * 0.5 );
diffuseColor.rgb = oFoamCol * oFoamN * oCov;   // foam is the only diffuse surface: lit by three
diffuseColor.a = clamp( max( smoothstep( 0.0, 0.18, oEdge ), oShoreFoam ), 0.0, 1.0 );
#ifdef OCEAN_SEETHROUGH
  // premultiplied: reflection + body added in full, what is behind kept by transmittance x (1 - F)
  diffuseColor.a *= clamp( 1.0 - dot( oTrans, vec3( 0.3333 ) ) * ( 1.0 - oFres ) * ( 1.0 - oCov ), 0.0, 1.0 );
#endif
float oA = roughnessFactor * roughnessFactor;
roughnessFactor = sqrt( sqrt( oA * oA + oLost ) );
roughnessFactor = mix( max( roughnessFactor, oRoughFar * smoothstep( 30.0, 2500.0, oDist ) ), 0.85, oCov );
vec3 normal = normalize( ( viewMatrix * vec4( oN, 0.0 ) ).xyz );
vec3 nonPerturbedNormal = normal;   // pixel-to-pixel normal change becomes roughness (specular AA)
`

const FRAG_AFTER_LIGHTS = /* glsl */`
#include <lights_fragment_end>
float oKeep = 1.0 - oCov;
reflectedLight.directSpecular *= oKeep;
reflectedLight.indirectSpecular *= oKeep;
#ifndef USE_ENVMAP
  // no environment: reflect the hemisphere/ambient sky so the sea is never a black mirror
  vec3 oR = reflect( -oV, oN );
  vec3 oRefl = getAmbientLightIrradiance( ambientLightColor );
  #if NUM_HEMI_LIGHTS > 0
    for ( int i = 0; i < NUM_HEMI_LIGHTS; i ++ ) oRefl += getHemisphereLightIrradiance( hemisphereLights[ i ], normalize( ( viewMatrix * vec4( oR, 0.0 ) ).xyz ) );
  #endif
  reflectedLight.indirectSpecular += oRefl * RECIPROCAL_PI * oFres * oKeep;
#endif
totalEmissiveRadiance += oBody * ( 1.0 - oFres ) * oKeep;
`

// ------------------------------------------------------------------ factory

const PRESETS = {
  ocean: { windSpeed: 9, fetch: 100000, choppiness: 1.3, foam: 1, swell: 1, detail: 0.1, deepColor: '#0a2432', scatterColor: '#2f7d6d', absorb: [0.42, 0.085, 0.033], roughness: 0.06, roughFar: 0.3, flatten: 0.6, sss: 0.55 },
  calm: { windSpeed: 3, fetch: 3000, choppiness: 0.7, foam: 0, swell: 0, detail: 0.03, deepColor: '#06100f', scatterColor: '#18392f', absorb: [0.6, 0.22, 0.2], roughness: 0.03, roughFar: 0.08, flatten: 0.85, sss: 0.25 },
}

export function createOcean(opts = {}) {
  const t0 = performance.now()
  const mode = opts.mode === 'calm' ? 'calm' : 'ocean'
  const P = PRESETS[mode]
  // Calm water smaller than 30 m (pools, fountains, small ponds) gets pool-sized ripples.
  const small = mode === 'calm' && opts.size && Math.max(...[].concat(opts.size)) < 30
  const params = {
    windSpeed: opts.windSpeed ?? (small ? 2 : P.windSpeed),
    windDirection: opts.windDirection ?? 45,
    swellDirection: opts.swellDirection,
    waveScale: opts.waveScale ?? (small ? 0.12 : 1),
    choppiness: opts.choppiness ?? P.choppiness,
    foam: opts.foam ?? P.foam,
    swell: opts.swell ?? P.swell,
    fetch: opts.fetch ?? P.fetch,
    depth: opts.depth ?? 500,
  }
  const seaLevel = opts.seaLevel ?? 0
  const seed = opts.seed ?? 1
  const name = opts.name ?? (mode === 'calm' ? 'Calm water' : 'Ocean')

  // Cascades: patch L (m), grid N. Disjoint wavenumber bands [6·2π/L_i, 6·2π/L_{i+1}); each
  // band's shortest wave stays above its own patch Nyquist. The 1 km patch is the sea's period:
  // room for wave groups and the swell. The calm preset skips it.
  const cascades = [
    { L: 1000, N: 128, foam: true }, { L: 100, N: 128, foam: true }, { L: 10, N: 64, foam: false },
  ]
  if (mode === 'calm') cascades[0].off = true
  cascades.forEach((c, i) => {
    c.lo = i === 0 ? 1e-4 : 2 * Math.PI / c.L * 6
    c.hi = i === cascades.length - 1 ? 1e6 : 2 * Math.PI / cascades[i + 1].L * 6
    const M = c.N * c.N
    c.dk = 2 * Math.PI / c.L
    c.nf = c.foam ? 5 : 3
    c.kx = new Float32Array(M); c.kz = new Float32Array(M); c.kl = new Float32Array(M); c.ki = new Float32Array(M); c.om = new Float32Array(M)
    c.h0r = new Float32Array(M); c.h0i = new Float32Array(M); c.hmr = new Float32Array(M); c.hmi = new Float32Array(M)
    c.live = new Uint8Array(M)
    c.re = []; c.im = []
    for (let f = 0; f < c.nf; f++) { c.re.push(new Float32Array(M)); c.im.push(new Float32Array(M)) }
    c.fft = makeFFT2D(c.N)
    c.disp = new Float32Array(M * 4); c.der = new Float32Array(M * 4)
    c.dispTex = floatTex(c.disp, c.N, true); c.derTex = floatTex(c.der, c.N, true)
    const rnd = mulberry32(seed * 7919 + i * 104729 + 13)
    c.xi = new Float32Array(M * 2)
    for (let o = 0; o < M; o++) {
      const u1 = Math.max(rnd(), 1e-9), u2 = rnd(), r = Math.sqrt(-2 * Math.log(u1))
      c.xi[o * 2] = r * Math.cos(2 * Math.PI * u2); c.xi[o * 2 + 1] = r * Math.sin(2 * Math.PI * u2)
    }
    for (let j = 0; j < c.N; j++) for (let ii = 0; ii < c.N; ii++) {
      const o = j * c.N + ii, nx = ii < c.N / 2 ? ii : ii - c.N, nz = j < c.N / 2 ? j : j - c.N
      const kx = nx * c.dk, kz = nz * c.dk, k = Math.hypot(kx, kz)
      c.kx[o] = kx; c.kz[o] = kz; c.kl[o] = k; c.ki[o] = k > 1e-6 ? 1 / k : 0
    }
  })

  const stats = { updateMs: 0, buildMs: 0, waveHeight: 0, peakWavelength: 0, triangles: 0, vertices: 0, draws: 1 }
  // Seconds looked back for whitecap persistence. The analytic-signal rotation that stands in
  // for the past is good to ~35% error over 1 s for the 1 km band and over ~0.4 s for the
  // broader 100 m band (measured), so each band only looks back that far.
  const HIST = [[0.2, 0.45, 0.75, 1.1], [0.12, 0.25, 0.4], []]
  const RECOVER = 0.55 // turbulence recovered per second after a fold (original foam.decay ~0.4-0.8)

  // h0(k) for every cascade — start-up and whenever a spectrum parameter changes (~5 ms)
  function bake() {
    const swellDir = params.swellDirection ?? params.windDirection + 25
    const layers = [makeLayer(1, Math.max(params.windSpeed, 0.5), params.windDirection, params.fetch, mode === 'calm' ? 0.6 : 0.9, 0.2)]
    if (params.swell > 0) layers.push(makeLayer(0.12 * params.swell, 14, swellDir, 800000, 1, 1))
    let variance = 0
    for (const c of cascades) {
      const M = c.N * c.N
      let wSumD = 0, wD = 0, wSumH = 0, wH = 0, slope = 0
      for (let o = 0; o < M; o++) {
        const k = c.kl[o], inBand = !c.off && k >= c.lo && k < c.hi
        const kS = Math.max(k, c.lo), kd = Math.min(kS * params.depth, 20), th = Math.tanh(kd)
        const omega = Math.sqrt(G * kS * th), ch = Math.cosh(kd)
        const dOmega = G * (params.depth * kS / (ch * ch) + th) / (2 * omega)
        c.om[o] = omega
        if (!inBand) { c.h0r[o] = c.h0i[o] = 0; continue }
        const theta = Math.atan2(c.kz[o], c.kx[o])
        let S = 0
        for (const Ly of layers) S += layerS(omega, theta, params.depth, Ly) * Math.exp(-kS * kS * Ly.fade * Ly.fade)
        const amp = Math.sqrt(Math.max(2 * S * Math.abs(dOmega) / kS, 0)) * c.dk * params.waveScale
        c.h0r[o] = c.xi[o * 2] * amp; c.h0i[o] = c.xi[o * 2 + 1] * amp
      }
      for (let j = 0; j < c.N; j++) for (let i = 0; i < c.N; i++) {
        const o = j * c.N + i, m = ((c.N - j) % c.N) * c.N + ((c.N - i) % c.N)
        c.hmr[o] = c.h0r[m]; c.hmi[o] = -c.h0i[m]
        c.live[o] = c.h0r[o] !== 0 || c.h0i[o] !== 0 || c.hmr[o] !== 0 || c.hmi[o] !== 0 ? 1 : 0
        const e = c.h0r[o] ** 2 + c.h0i[o] ** 2 + c.hmr[o] ** 2 + c.hmi[o] ** 2
        variance += e; wSumH += e * c.om[o]; wH += e
        const ed = e * c.kl[o] * c.kl[o]; wSumD += ed * c.om[o]; wD += ed; slope += ed
      }
      c.wH = wH > 0 ? wSumH / wH : 1; c.wD = wD > 0 ? wSumD / wD : 1
      c.slopeVar = slope
      // history rotations of the analytic divergence: J(t - s) ~ Re[Zdiv(t) e^{i w s}]
      c.hist = HIST[cascades.indexOf(c)]
      c.hc = c.hist.map((s) => Math.cos(c.wD * s)); c.hs = c.hist.map((s) => Math.sin(c.wD * s))
    }
    stats.waveHeight = +(4 * Math.sqrt(variance)).toFixed(2)
    if (uniforms) {
      uniforms.oSlopeVar.value.set(...cascades.map((c) => c.slopeVar))
      const a = THREE.MathUtils.degToRad(params.windDirection); uniforms.oWind.value.set(Math.cos(a), Math.sin(a))
    }
    const wp = layers[0].peakOmega
    stats.peakWavelength = +(2 * Math.PI * G / (wp * wp)).toFixed(1)
  }

  // ---- per-frame CPU: evolve to t, 5 (3) packed IFFTs per cascade, assemble + foam
  let lastTime = null
  function compute(time) {
    const lam = params.choppiness
    uniforms.oFoamAmt.value = params.foam
    for (const c of cascades) {
      if (c.off) continue
      const M = c.N * c.N, [f0r, f1r, f2r, f3r, f4r] = c.re, [f0i, f1i, f2i, f3i, f4i] = c.im
      const { h0r, h0i, hmr, hmi, kx: KX, kz: KZ, kl: KL, ki: KI, om } = c
      const live = c.live
      for (let o = 0; o < M; o++) {
        if (!live[o]) { f0r[o] = f0i[o] = f1r[o] = f1i[o] = f2r[o] = f2i[o] = 0; if (c.foam) f3r[o] = f3i[o] = f4r[o] = f4i[o] = 0; continue }
        const w = om[o] * time, cw = Math.cos(w), sw = Math.sin(w)
        const ar = h0r[o], ai = h0i[o], br = hmr[o], bi = hmi[o]
        const pr = ar * cw + ai * sw, pi = ai * cw - ar * sw // h0(k) e^{-iwt}
        const qr = br * cw - bi * sw, qi = br * sw + bi * cw // conj(h0(-k)) e^{+iwt}
        const Hr = pr + qr, Hi = pi + qi
        const kx = KX[o], kz = KZ[o], ik = KI[o], ux = kx * ik, uz = kz * ik
        f0r[o] = -ux * Hi - uz * Hr; f0i[o] = ux * Hr - uz * Hi // Dx + i Dz   (D = i k/|k| H)
        f2r[o] = -kx * Hi - kz * Hr; f2i[o] = kx * Hr - kz * Hi // dDy/dx + i dDy/dz
        if (c.foam) {
          f1r[o] = 2 * pr; f1i[o] = 2 * pi // analytic height: Dy + i H_t[Dy]
          const axx = kx * ux, azz = kz * uz, axz = kx * uz, kl = KL[o]
          f3r[o] = -axx * Hr + azz * Hi; f3i[o] = -axx * Hi - azz * Hr // dDx/dx + i dDz/dz
          f4r[o] = -axz * Hr - kl * (pr - qr); f4i[o] = -axz * Hi - kl * (pi - qi) // dDx/dz + i H_t[div]
        } else {
          const kl = KL[o]
          f1r[o] = Hr + kl * Hi; f1i[o] = Hi - kl * Hr // Dy + i div
        }
      }
      for (let f = 0; f < c.nf; f++) c.fft(c.re[f], c.im[f])
      const disp = c.disp, der = c.der
      if (c.foam) {
        const hc = c.hc, hs = c.hs, hist = c.hist, K = hist.length
        for (let o = 0; o < M; o++) {
          const a = f3r[o], b = f3i[o], cc = f4r[o], div = a + b, hd = f4i[o]
          const o4 = o * 4
          disp[o4] = lam * f0r[o]; disp[o4 + 1] = f1r[o]; disp[o4 + 2] = lam * f0i[o]
          der[o4] = f2r[o]; der[o4 + 1] = f2i[o]; der[o4 + 2] = lam * a; der[o4 + 3] = lam * b
          // Jacobian now, and its linear part rotated back over the last 1.7 s: a whitecap
          // lingers after the fold that made it and recovers at RECOVER per second
          const J = (1 + lam * a) * (1 + lam * b) - lam * lam * cc * cc
          let turb = J
          for (let j = 0; j < K; j++) {
            const Jh = J + lam * (div * hc[j] - hd * hs[j] - div) + RECOVER * hist[j]
            if (Jh < turb) turb = Jh
          }
          disp[o4 + 3] = turb // raw: thresholded per pixel, so foam keeps sharp edges inside a texel
        }
      } else {
        for (let o = 0; o < M; o++) {
          const o4 = o * 4, half = 0.5 * lam * f1i[o]
          disp[o4] = lam * f0r[o]; disp[o4 + 1] = f1r[o]; disp[o4 + 2] = lam * f0i[o]; disp[o4 + 3] = 0
          der[o4] = f2r[o]; der[o4 + 1] = f2i[o]; der[o4 + 2] = half; der[o4 + 3] = half
        }
      }
      c.dispTex.needsUpdate = true; c.derTex.needsUpdate = true
    }
  }

  // ---- seabed
  let bed = null // { texture, bounds, data?, res?, heightAt? }
  const bedRect = new THREE.Vector4(0, 0, 1, 1)
  const placeholder = new THREE.DataTexture(new Float32Array([-DEEP, -1e4, 0, 0]), 1, 1, THREE.RGBAFormat, THREE.FloatType)
  placeholder.needsUpdate = true

  // ---- material
  const sunDir = new THREE.Vector3(0.3, 0.6, -0.5).normalize(), sunCol = new THREE.Color(3, 2.9, 2.7)
  let sunLight = opts.sun ?? null, sunExplicit = false
  const uniforms = {
    oDisp0: { value: cascades[0].dispTex }, oDisp1: { value: cascades[1].dispTex }, oDisp2: { value: cascades[2].dispTex },
    oDer0: { value: cascades[0].derTex }, oDer1: { value: cascades[1].derTex }, oDer2: { value: cascades[2].derTex },
    oNoise: { value: detailNoise() },
    oL: { value: new THREE.Vector3(...cascades.map((c) => c.L)) },
    oTexel: { value: new THREE.Vector3(...cascades.map((c) => c.L / c.N)) },
    oOn: { value: new THREE.Vector3(...cascades.map((c) => (c.off ? 0 : 1))) },
    oTime: { value: 0 }, oSeaLevel: { value: seaLevel }, oSwash: { value: opts.swash ?? (small ? 0 : mode === 'calm' ? 0.25 : 1) },
    oBed: { value: placeholder }, oBedRect: { value: bedRect }, oBedMix: { value: 1 },
    oCellK: { value: 0 }, oCellMin: { value: 0.25 }, oFar: { value: 0 },
    oScatter: { value: new THREE.Color(opts.scatterColor ?? P.scatterColor) },
    oFoamCol: { value: new THREE.Color(opts.foamColor ?? '#e9efe6') },
    oBedColor: { value: new THREE.Color(opts.seabedColor ?? '#8a7d64') },
    oAbsorb: { value: new THREE.Vector3(...(opts.absorb ?? P.absorb)) },
    oSunDir: { value: sunDir }, oSunCol: { value: sunCol },
    oDetail: { value: P.detail }, oSSS: { value: opts.sss ?? P.sss }, oCaustics: { value: 0.9 },
    oPxPerM: { value: 1.3e-3 }, oBodyGain: { value: opts.bodyGain ?? 0.55 },
    oRoughFar: { value: P.roughFar }, oFlatten: { value: P.flatten }, oFoamAmt: { value: params.foam },
    oSlopeVar: { value: new THREE.Vector3() }, oBandMin: { value: new THREE.Vector3(cascades[1].L / 6, cascades[2].L / 6, 2 * cascades[2].L / cascades[2].N) },
    oWind: { value: new THREE.Vector2(1, 0) }, oShoreFoamK: { value: mode === 'calm' ? 0 : 1 },
  }
  // The material card stays meaningful: colour = deep water colour, roughness = near-field
  // roughness (the far field rises toward oRoughFar). Everything else is in the shader.
  const material = new THREE.MeshPhysicalMaterial({
    color: opts.deepColor ?? P.deepColor, roughness: P.roughness, metalness: 0, ior: 1.333, specularIntensity: 1,
    side: THREE.DoubleSide,
  })
  material.forceSinglePass = true // transparent + DoubleSide would otherwise draw twice
  material.name = opts.materialName ?? (mode === 'calm' ? 'Water · Calm' : 'Ocean · Water')
  material.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, uniforms)
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\n' + DECL + VERT_DECL)
      .replace('#include <begin_vertex>', VERT_BODY)
      .replace('#include <project_vertex>', VERT_PROJECT)
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', '#include <common>\n' + DECL + FRAG_DECL)
      .replace('#include <normal_fragment_begin>', FRAG_NORMAL)
      .replace('#include <lights_fragment_end>', FRAG_AFTER_LIGHTS)
  }
  material.customProgramCacheKey = () => 'edit3d-ocean-v2'

  // ---- geometry: boundless polar mesh around the camera, or a finite plane
  let geometry, boundless = !opts.size
  const detail = opts.detail ?? 1
  if (boundless) {
    // square cells growing with radius: 0.25 m at the centre, ~2.5 m at 100 m, out to 60 km
    const segs = Math.max(64, Math.round(256 * Math.sqrt(detail) / 4) * 4), q = Math.exp(2 * Math.PI / segs)
    const r0 = 0.25, cr = r0 / (q - 1), R = opts.radius ?? 60000
    const rings = Math.ceil(Math.log(R / cr + 1) / Math.log(q))
    const pos = new Float32Array((1 + rings * segs) * 3)
    for (let j = 1; j <= rings; j++) {
      const r = Math.min(R, cr * (Math.pow(q, j) - 1))
      for (let i = 0; i < segs; i++) {
        const a = i / segs * Math.PI * 2, o = (1 + (j - 1) * segs + i) * 3
        pos[o] = Math.cos(a) * r; pos[o + 2] = Math.sin(a) * r
      }
    }
    const idx = new Uint32Array((segs + (rings - 1) * segs * 2) * 3)
    let k = 0
    const ring = (j, i) => 1 + (j - 1) * segs + (i % segs)
    for (let i = 0; i < segs; i++) { idx[k++] = 0; idx[k++] = ring(1, i + 1); idx[k++] = ring(1, i) }
    for (let j = 1; j < rings; j++) for (let i = 0; i < segs; i++) {
      const a = ring(j, i), b = ring(j, i + 1), c = ring(j + 1, i), d = ring(j + 1, i + 1)
      idx[k++] = a; idx[k++] = b; idx[k++] = d; idx[k++] = a; idx[k++] = d; idx[k++] = c
    }
    geometry = new THREE.BufferGeometry()
    geometry.setAttribute('position', new THREE.BufferAttribute(pos, 3))
    const nrm = new Float32Array(pos.length); for (let i = 1; i < nrm.length; i += 3) nrm[i] = 1
    geometry.setAttribute('normal', new THREE.BufferAttribute(nrm, 3))
    geometry.setIndex(new THREE.BufferAttribute(idx, 1))
    geometry.boundingSphere = new THREE.Sphere(new THREE.Vector3(), R)
    uniforms.oCellK.value = q - 1; uniforms.oCellMin.value = r0
  } else {
    const [w, d] = Array.isArray(opts.size) ? opts.size : [opts.size, opts.size]
    const cell = Math.max(0.3 / Math.sqrt(detail), Math.max(w, d) / 512, Math.sqrt(w * d / 40000)) // <= ~40k vertices
    geometry = new THREE.PlaneGeometry(w, d, Math.ceil(w / cell), Math.ceil(d / cell))
    geometry.rotateX(-Math.PI / 2)
    uniforms.oCellK.value = 0; uniforms.oCellMin.value = cell
  }
  stats.triangles = (geometry.index ? geometry.index.count : geometry.attributes.position.count) / 3
  stats.vertices = geometry.attributes.position.count

  const mesh = new THREE.Mesh(geometry, material)
  mesh.name = name
  mesh.frustumCulled = false
  mesh.receiveShadow = true
  mesh.castShadow = false
  const center = opts.center ?? [0, 0]
  mesh.position.set(boundless ? 0 : center[0], seaLevel, boundless ? 0 : center[1])

  const _v = new THREE.Vector3(), _t = new THREE.Vector3(), _size = new THREE.Vector2()
  let sceneSun = null, sceneRef = null
  mesh.onBeforeRender = (renderer, scene, camera) => {
    _v.setFromMatrixPosition(camera.matrixWorld)
    if (boundless) {
      mesh.position.set(_v.x, seaLevel, _v.z)
      mesh.updateMatrixWorld()
    }
    uniforms.oFar.value = camera.isPerspectiveCamera ? camera.far * 0.9 : 0
    renderer.getDrawingBufferSize(_size)
    uniforms.oPxPerM.value = camera.isPerspectiveCamera ? 2 * Math.tan(THREE.MathUtils.degToRad(camera.fov) / 2) / camera.zoom / Math.max(_size.y, 1) : 1e-3
    // the sun: explicit setSun, else a given light, else the first DirectionalLight in the scene
    if (!sunExplicit) {
      let light = sunLight
      if (!light) {
        if (sceneRef !== scene || !sceneSun || !sceneSun.parent) {
          sceneRef = scene; sceneSun = null
          scene.traverse((o) => { if (!sceneSun && o.isDirectionalLight && o.visible) sceneSun = o })
        }
        light = sceneSun
      }
      if (light) {
        light.updateMatrixWorld()
        _t.setFromMatrixPosition(light.target.matrixWorld)
        sunDir.setFromMatrixPosition(light.matrixWorld).sub(_t).normalize()
        sunCol.copy(light.color).multiplyScalar(light.intensity)
      }
    }
  }

  const seeThrough = opts.seeThrough ?? mode === 'calm' // calm water: the real floor under it shows through
  function setSeabed(sb) {
    bed = null
    if (sb) {
      if (sb.heightTexture && sb.bounds) {
        bed = { texture: sb.heightTexture, bounds: sb.bounds, heightAt: sb.heightAt?.bind(sb) }
      } else if ((sb.heightAt || sb.depthAt) && sb.bounds) {
        const fn = sb.heightAt ? (x, z) => sb.heightAt(x, z) : (x, z) => seaLevel - sb.depthAt(x, z)
        const baked = bakeSeabed(fn, sb.bounds, seaLevel, sb.resolution ?? 256)
        bed = { texture: baked.texture, bounds: baked.bounds, heightAt: fn, baked: true }
      } else {
        console.warn('createOcean: seabed needs { heightTexture, bounds } or { heightAt | depthAt, bounds }')
      }
    }
    if (bed) {
      const b = bed.bounds
      bedRect.set(b.minX, b.minZ, 1 / (b.maxX - b.minX), 1 / (b.maxZ - b.minZ))
      uniforms.oBed.value = bed.texture
      material.defines = { OCEAN_SEABED: '' }
      material.transparent = true // the last centimetres of swash fade into the sand
      material.depthWrite = true
      if (seeThrough) {
        material.defines.OCEAN_SEETHROUGH = ''
        material.blending = THREE.CustomBlending
        material.blendSrc = THREE.OneFactor; material.blendDst = THREE.OneMinusSrcAlphaFactor
        material.blendSrcAlpha = THREE.OneFactor; material.blendDstAlpha = THREE.OneMinusSrcAlphaFactor
      }
    } else {
      uniforms.oBed.value = placeholder
      material.defines = {}
      material.transparent = false
    }
    material.needsUpdate = true
  }
  if (opts.seabed) setSeabed(opts.seabed)

  // ---- CPU sampling for floating objects
  function sampleDisp(c, x, z, out) {
    const N = c.N, u = x / c.L * N - 0.5, v = z / c.L * N - 0.5
    const i0 = Math.floor(u), j0 = Math.floor(v), fu = u - i0, fv = v - j0
    const i1 = ((i0 + 1) % N + N) % N, j1 = ((j0 + 1) % N + N) % N, ia = ((i0 % N) + N) % N, ja = ((j0 % N) + N) % N
    const d = c.disp
    for (let ch = 0; ch < 3; ch++) {
      const a = d[(ja * N + ia) * 4 + ch], b = d[(ja * N + i1) * 4 + ch], e = d[(j1 * N + ia) * 4 + ch], f = d[(j1 * N + i1) * 4 + ch]
      out[ch] += (a * (1 - fu) + b * fu) * (1 - fv) + (e * (1 - fu) + f * fu) * fv
    }
  }
  const _d = [0, 0, 0]
  function dispAt(x, z) {
    _d[0] = _d[1] = _d[2] = 0
    for (const c of cascades) if (!c.off) sampleDisp(c, x, z, _d)
    return _d
  }
  function heightAt(x, z) {
    // invert the horizontal (choppy) displacement: find the grid point that lands on (x, z)
    let px = x, pz = z
    for (let it = 0; it < 3; it++) { const d = dispAt(px, pz); px = x - d[0]; pz = z - d[2] }
    let y = dispAt(px, pz)[1]
    if (bed?.heightAt) {
      const b = bed.bounds, u = (x - b.minX) / (b.maxX - b.minX), v = (z - b.minZ) / (b.maxZ - b.minZ)
      if (u > 0 && u < 1 && v > 0 && v < 1) {
        const sd = Math.max(seaLevel - bed.heightAt(x, z), 0)
        const sm = (a, b2, t) => { const k = Math.min(Math.max((t - a) / (b2 - a), 0), 1); return k * k * (3 - 2 * k) }
        y *= (1 + 0.55 * sm(17, 3.5, sd)) * sm(0.25, 2.6, sd)
        const room = sd * 0.62 + 0.04, pos = Math.max(y, 0)
        y = y + (pos + room * (Math.exp((y - pos) / room) - 1) - y) * sm(9, 0.4, sd)
      }
    }
    return seaLevel + y
  }

  bake()
  const startTime = opts.time ?? 0
  compute(startTime); lastTime = startTime; uniforms.oTime.value = startTime
  stats.buildMs = +(performance.now() - t0).toFixed(1)

  return {
    mesh, material, stats, params, mode,
    // Absolute time in seconds. Same t -> same frame; repeated t costs nothing.
    update(time, force = false) {
      if (time === lastTime && !force) return
      const s = performance.now()
      compute(time); lastTime = time; uniforms.oTime.value = time
      stats.updateMs = +(performance.now() - s).toFixed(2)
    },
    // Live parameter changes (windSpeed, windDirection, swellDirection, swell, waveScale, fetch,
    // depth re-bake the spectrum, ~5 ms; choppiness and foam only re-assemble).
    setWaves(p = {}) {
      let rebake = false
      for (const k of ['windSpeed', 'windDirection', 'swellDirection', 'swell', 'waveScale', 'fetch', 'depth']) {
        if (p[k] !== undefined && p[k] !== params[k]) { params[k] = p[k]; rebake = true }
      }
      for (const k of ['choppiness', 'foam']) if (p[k] !== undefined) params[k] = p[k]
      if (rebake) bake()
      compute(lastTime ?? 0)
    },
    // direction toward the sun (any length) and its colour × intensity (linear, light units)
    setSun(direction, color) {
      sunExplicit = true
      sunDir.copy(direction).normalize()
      if (color) sunCol.copy(color)
    },
    followLight(light) { sunLight = light; sunExplicit = false },
    setSeabed,
    setSeabedVisible(on) { uniforms.oBedMix.value = on ? 1 : 0 },
    heightAt,
    // surface normal at (x, z), from three heightAt taps
    normalAt(x, z, out = new THREE.Vector3()) {
      const e = 0.5, h = heightAt(x, z)
      return out.set(h - heightAt(x + e, z), e, h - heightAt(x, z + e)).normalize()
    },
    uniforms,
    dispose() {
      geometry.dispose(); material.dispose(); placeholder.dispose()
      for (const c of cascades) { c.dispTex.dispose(); c.derTex.dispose() }
      if (bed?.baked) bed.texture.dispose()
    },
  }
}

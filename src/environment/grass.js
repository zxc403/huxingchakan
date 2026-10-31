// grass.js — a wind-swept meadow of individual blades, placed and animated entirely in the vertex
// stage (no models, no textures on the blade). Blades sit on a WORLD-FIXED hashed grid that is
// re-centred on whichever camera renders it, so the field is stable while the camera moves, works
// with on-demand edit-mode renders and every viewport, and needs no per-frame CPU work besides wind.
//
//   import { createGrass } from './environment/grass.js'
//   const grass = createGrass({ heightAt, heightTexture, bounds, mask, exclude: [{ path: [[0,-40],[5,0],[0,40]], width: 1.6 }] })
//   scene.add(grass.object)
//   ground.material.color.copy(grass.groundColor)     // the turf under/beyond the blades: far field blends into it
//   asset.registerAnimation('wind', { objectId: 'grass', duration: 60, sample: (t) => grass.update(t) })
//   grass.set({ height: 0.6, density: 1.5, dryness: 0.3, wind: { strength: 0.5 } })   // live
//
// Parameters that matter (all optional; defaults already look finished):
//   height     mean blade LENGTH in metres (0.15 lawn … 1.0 meadow … 1.6 tall prairie). Blades bow over,
//              so they stand ~0.65 × height tall. Default 1.0 (knee-to-thigh on a 1.75 m person).
//   density    blades per m² ≈ 80 × density (1 = 11 cm spacing). 0.4–2.5. Cost scales with it.
//   radius     reach of the blade field around the camera in metres (default 100, grows with altitude).
//   dryness    0 lush · 0.2 fresh meadow (default) · 0.5 summer · 0.8 late summer · 1 straw.
//              `colors` { dark, base, tip, warm, rust } (sRGB arrays) override entries. patchSize: colour
//              patch scale in metres (100).
//   wind       { strength 0–1 (0.32), speed (0.18), direction [x,z] or degrees, coverage 0–1 (0.6), events 0–1 (1) }
//   ground     heightAt(x,z) (CPU; baked to a texture over `bounds` when no heightTexture), or
//              heightTexture + bounds {minX,minZ,maxX,maxZ} (height in channel R, metres; texel centres on samples).
//   mask       0..1 grass density: a texture over `bounds` (channel: maskChannel; terrain.heightTexture → A,
//              the default when heightTexture is a terrain's: no blades on sand, rock, scree or building pads),
//              or a function (x,z)=>0..1 (baked), or a number. Low density = shorter, then no blades.
//   exclude    up to 32 bare shapes: { path:[[x,z],..], width, feather } · { rect:[cx,cz,w,d], angle, feather }
//              · { circle:[cx,cz,r], feather }  (paths, building footprints, ponds).
//   area       bounded patch instead of an endless field: { center:[x,z], size:[w,d], angle, feather }
//              or { center:[x,z], radius, feather } (lawn, garden bed). Same LOD rings, clipped to the patch.
// Lighting: MeshLambertMaterial underneath — follows the scene's DirectionalLight (incl. its shadow map),
// HemisphereLight, scene.environment, fog and tone mapping automatically; blades add canopy wrap,
// root AO and translucency toward the light. setSun(dir, radiance) is only used when there is no
// DirectionalLight in the scene.
// Cost (measured, Apple M-series, 1280×557 viewport): 3 draws (LOD rings 7/4/2 segments); eye level
// 113 k blades / 0.66 M tris drawn of 0.42 M instances processed; 30 m up 128 k / 0.52 M of 0.61 M;
// GPU ≈ 5–6.5 ms per frame at default density/radius (lower density or radius to trade); update(time)
// < 0.001 ms; build ≈ 8 ms (+ ~10 ms per baked height/mask). stats(camera) reports exact drawn counts.
// Ported from Kimi's world-building template (WebGPU/TSL) to WebGL for Edit3D.
import * as THREE from 'three'

const BLADE_HEIGHT = 1.75 // original blade units: lengths are scale × BLADE_HEIGHT
const BLADE_WIDTH = 0.15
const MEAN_SCALE = 0.73 // mean of the spatial scale noise → height = MEAN_SCALE × 1.75 × size
const MAX_EXCL = 32
// LOD rings: segments per blade, spacing multiplier vs ring 0, outer radius as a fraction of reach
const RINGS = [
  { seg: 7, spacing: 1.0, outer: 0.15 },
  { seg: 4, spacing: 1.6, outer: 0.42 },
  { seg: 2, spacing: 2.7, outer: 1.0 },
]
const BASE_SPACING = 0.11 // metres at density 1

// palettes (sRGB) — lush is the template's grass/config.js palette
// dryness 0 → LUSH, 0.2 → TEMPLATE (the original meadow, exactly), 1 → DRY
const PALETTE_LUSH = { dark: [0.07, 0.15, 0.055], base: [0.19, 0.4, 0.15], tip: [0.31, 0.46, 0.26], warm: [0.6, 0.54, 0.38], rust: [0.38, 0.19, 0.11] }
const PALETTE_TEMPLATE = { dark: [0.09, 0.15, 0.075], base: [0.23, 0.38, 0.19], tip: [0.35, 0.43, 0.32], warm: [0.66, 0.53, 0.41], rust: [0.38, 0.19, 0.11] }
const PALETTE_DRY = { dark: [0.24, 0.2, 0.1], base: [0.58, 0.5, 0.29], tip: [0.76, 0.68, 0.46], warm: [0.8, 0.66, 0.44], rust: [0.47, 0.29, 0.15] }

// ------------------------------------------------------------------ deterministic helpers
function pcg(v) {
  const s = (Math.imul(v >>> 0, 747796405) + 2891336453) >>> 0
  const w = Math.imul(((s >>> ((s >>> 28) + 4)) ^ s) >>> 0, 277803737) >>> 0
  return ((w >>> 22) ^ w) >>> 0
}
const u01 = (h) => h / 4294967295

// Tileable 4-channel sum-of-sines noise (the template's gust texture, seed 977): R gust field,
// G position/colour noise + eddies, B scale noise, A spare. Factorised: sin(a+b) = sin a cos b + cos a sin b.
function makeNoiseTexture(size = 128) {
  let seed = 977
  const rand = () => (seed = (seed * 16807) % 2147483647) / 2147483647
  const channels = []
  for (let ch = 0; ch < 4; ch++) {
    const waves = []
    for (let i = 0; i < 9; i++) {
      waves.push({
        fx: Math.round(1 + rand() * 4) * (rand() > 0.5 ? 1 : -1),
        fy: Math.round(1 + rand() * 4) * (rand() > 0.5 ? 1 : -1),
        phase: rand() * Math.PI * 2,
        amp: 0.5 + rand(),
      })
    }
    channels.push(waves)
  }
  const data = new Uint8Array(size * size * 4)
  const f = new Float32Array(size * size)
  for (let ch = 0; ch < 4; ch++) {
    f.fill(0)
    let norm = 0
    for (const w of channels[ch]) {
      norm += w.amp
      const sx = new Float32Array(size), cx = new Float32Array(size), sy = new Float32Array(size), cy = new Float32Array(size)
      for (let i = 0; i < size; i++) {
        const ax = (2 * Math.PI * w.fx * i) / size + w.phase, ay = (2 * Math.PI * w.fy * i) / size
        sx[i] = Math.sin(ax); cx[i] = Math.cos(ax); sy[i] = Math.sin(ay); cy[i] = Math.cos(ay)
      }
      for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) f[y * size + x] += w.amp * (sx[x] * cy[y] + cx[x] * sy[y])
    }
    for (let i = 0; i < size * size; i++) data[i * 4 + ch] = Math.round((f[i] / norm * 0.5 + 0.5) * 255)
  }
  const tex = new THREE.DataTexture(data, size, size, THREE.RGBAFormat)
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping
  tex.magFilter = tex.minFilter = THREE.LinearFilter
  tex.name = 'grass.noise'
  tex.needsUpdate = true
  return tex
}

// bilinear sampler over a DataTexture's CPU data (texel centres at (i+0.5)/N, clamp or repeat)
function makeSampler(tex, channel = 0, repeat = false) {
  const img = tex?.image
  if (!img?.data) return null
  const { width: W, height: H, data } = img
  const stride = tex.format === THREE.RedFormat ? 1 : tex.format === THREE.RGFormat ? 2 : 4
  const half = tex.type === THREE.HalfFloatType
  const norm = data instanceof Uint8Array ? 1 / 255 : 1
  const at = (x, y) => {
    if (repeat) { x = ((x % W) + W) % W; y = ((y % H) + H) % H } else { x = Math.min(Math.max(x, 0), W - 1); y = Math.min(Math.max(y, 0), H - 1) }
    const v = data[(y * W + x) * stride + channel]
    return half ? THREE.DataUtils.fromHalfFloat(v) : v * norm
  }
  return (u, v) => {
    const px = u * W - 0.5, py = v * H - 0.5
    const x0 = Math.floor(px), y0 = Math.floor(py), fx = px - x0, fy = py - y0
    const a = at(x0, y0), b = at(x0 + 1, y0), c = at(x0, y0 + 1), d = at(x0 + 1, y0 + 1)
    return (a + (b - a) * fx) * (1 - fy) + (c + (d - c) * fx) * fy
  }
}

// bake a CPU function over bounds into a float/byte texture (texel centres on the samples)
function bake(fn, bounds, res, asBytes) {
  const W = res, H = res
  const data = asBytes ? new Uint8Array(W * H) : new Float32Array(W * H)
  const sx = (bounds.maxX - bounds.minX) / W, sz = (bounds.maxZ - bounds.minZ) / H
  for (let j = 0; j < H; j++) {
    const z = bounds.minZ + (j + 0.5) * sz
    for (let i = 0; i < W; i++) {
      const v = fn(bounds.minX + (i + 0.5) * sx, z)
      data[j * W + i] = asBytes ? Math.round(Math.min(Math.max(v, 0), 1) * 255) : v
    }
  }
  const tex = new THREE.DataTexture(data, W, H, THREE.RedFormat, asBytes ? THREE.UnsignedByteType : THREE.FloatType)
  tex.magFilter = tex.minFilter = asBytes ? THREE.LinearFilter : THREE.NearestFilter
  tex.wrapS = tex.wrapT = THREE.ClampToEdgeWrapping
  tex.needsUpdate = true
  return tex
}

const srgbToLinear = (c) => (c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4))
function toLinearColor(v) {
  if (v?.isColor) return v.clone()
  if (Array.isArray(v)) return new THREE.Color(srgbToLinear(v[0]), srgbToLinear(v[1]), srgbToLinear(v[2]))
  return new THREE.Color(v) // hex / css string: three converts sRGB → linear
}

// One global wind source, deterministic in absolute time: the template's idle → direction → ramp →
// hold → decay state machine, unrolled from the seed into a schedule so update(t) is a pure lookup.
function makeWindSchedule(seed) {
  let s = (seed * 48271 + 20260816) % 2147483647 || 1
  const r = () => (s = (s * 48271) % 2147483647) / 2147483647
  const segs = []
  let t = 0, level = 0.35, veer = 0
  const STATES = ['idle', 'direction', 'ramp', 'hold', 'decay']
  for (let k = 0; t < 1800; k++) {
    const type = STATES[k % 5]
    const seg = { type, t0: t, l0: level, l1: level, v0: veer, v1: veer }
    if (type === 'idle') seg.dur = 2 + r() * 5
    else if (type === 'direction') { seg.dur = 1.5 + r() * 2; seg.v1 = (r() - 0.5) * Math.PI * 0.5 } // ±45° around the base heading
    else if (type === 'ramp') { seg.dur = 1 + r() * 2.5; seg.l1 = 0.55 + r() * 0.45 }
    else if (type === 'hold') seg.dur = 2 + r() * 6
    else { seg.dur = 2.5 + r() * 4; seg.l1 = 0.15 + r() * 0.25 }
    seg.t1 = t + seg.dur
    t = seg.t1; level = seg.l1; veer = seg.v1
    segs.push(seg)
  }
  const period = t
  return (time) => {
    const tt = ((time % period) + period) % period
    let lo = 0, hi = segs.length - 1
    while (lo < hi) { const mid = (lo + hi) >> 1; if (segs[mid].t1 <= tt) lo = mid + 1; else hi = mid }
    const g = segs[lo], k = Math.min((tt - g.t0) / g.dur, 1), e = k * k * (3 - 2 * k)
    return { level: g.l0 + (g.l1 - g.l0) * e, veer: g.v0 + (g.v1 - g.v0) * e }
  }
}

// ------------------------------------------------------------------ shaders
const VERT_PARS = /* glsl */ `
#define BLADE_HEIGHT ${BLADE_HEIGHT.toFixed(3)}
#define BLADE_WIDTH ${BLADE_WIDTH.toFixed(3)}
#define MAX_EXCL ${MAX_EXCL}
uniform float uTime;
uniform vec2 uWindDir;
uniform vec4 uWindA;    // strength, speed, uvScale, event
uniform vec4 uWindB;    // lull, coverage, eddy, sway
uniform vec4 uBend;     // baseBending, curveP1, curveP2, bendControlPoint
uniform vec4 uBlade;    // size, minScale, maxScale, widthMul
uniform vec4 uBlade2;   // bendDrop, rotationRandomness, seed, farWidthGain
uniform vec4 uBlade3;   // baseSpacing, spacingCompExp, rootSink, gustShade
uniform vec4 uColCfg2;  // 1 / patchSize, -, -, -
uniform sampler2D uNoise;
uniform sampler2D uHeightTex;
uniform vec4 uHeightRect; // minX, minZ, 1/spanX, 1/spanZ
uniform vec4 uHeightCfg;  // mode (0 flat, 1 texture), flatY, outsideKeep, -
uniform vec4 uHeightChan;
uniform sampler2D uMaskTex;
uniform vec4 uMaskRect;
uniform vec4 uMaskCfg;    // mode (0 none, 1 texture), scalar density, -, -
uniform vec4 uMaskChan;
uniform vec4 uArea;       // cx, cz, hx, hz
uniform vec4 uAreaCfg;    // mode (0 none, 1 rect, 2 ellipse), feather, cos(angle), sin(angle)
uniform vec4 uExcl[ MAX_EXCL * 2 ];
uniform int uExclCount;
uniform vec4 uRingA[ 3 ]; // originX, originZ, widthInCells, spacing
uniform vec4 uRingB[ 3 ]; // r0, r1, bandIn, bandOut
uniform vec4 uField;      // reach, -, farShadeStart, farShadeEnd
uniform vec3 uColDark;
uniform vec3 uColBase;
uniform vec3 uColTip;
uniform vec3 uColWarm;
uniform vec3 uColRust;
uniform vec3 uColGround;
uniform vec4 uColCfg;     // tipMix, variation, warmStrength, rustStrength
varying vec3 vGAlbedo;
varying vec4 vGData;      // h along blade, far factor, translucency weight, -

uint gPcg( uint v ) {
  uint s = v * 747796405u + 2891336453u;
  uint w = ( ( s >> ( ( s >> 28u ) + 4u ) ) ^ s ) * 277803737u;
  return ( w >> 22u ) ^ w;
}
float gU01( uint h ) { return float( h ) * ( 1.0 / 4294967295.0 ); }

float gHeightAt( vec2 xz, out vec2 grad, out float inside ) {
  grad = vec2( 0.0 ); inside = 1.0;
  if ( uHeightCfg.x < 0.5 ) return uHeightCfg.y;
  ivec2 sz = textureSize( uHeightTex, 0 );
  vec2 uv = ( xz - uHeightRect.xy ) * uHeightRect.zw;
  inside = ( uv.x >= 0.0 && uv.x <= 1.0 && uv.y >= 0.0 && uv.y <= 1.0 ) ? 1.0 : uHeightCfg.z;
  vec2 p = uv * vec2( sz ) - 0.5;
  vec2 i0 = floor( p ); vec2 f = p - i0;
  ivec2 a = clamp( ivec2( i0 ), ivec2( 0 ), sz - 1 );
  ivec2 b = clamp( ivec2( i0 ) + 1, ivec2( 0 ), sz - 1 );
  float h00 = dot( texelFetch( uHeightTex, a, 0 ), uHeightChan );
  float h10 = dot( texelFetch( uHeightTex, ivec2( b.x, a.y ), 0 ), uHeightChan );
  float h01 = dot( texelFetch( uHeightTex, ivec2( a.x, b.y ), 0 ), uHeightChan );
  float h11 = dot( texelFetch( uHeightTex, b, 0 ), uHeightChan );
  vec2 texelM = 1.0 / ( vec2( sz ) * uHeightRect.zw );
  grad = vec2( mix( h10 - h00, h11 - h01, f.y ) / texelM.x, mix( h01 - h00, h11 - h10, f.x ) / texelM.y );
  return mix( mix( h00, h10, f.x ), mix( h01, h11, f.x ), f.y );
}

float gArea( vec2 p ) {
  vec2 q = p - uArea.xy;
  q = vec2( q.x * uAreaCfg.z + q.y * uAreaCfg.w, - q.x * uAreaCfg.w + q.y * uAreaCfg.z );
  float sd;
  if ( uAreaCfg.x < 1.5 ) { vec2 d = abs( q ) - uArea.zw; sd = length( max( d, 0.0 ) ) + min( max( d.x, d.y ), 0.0 ); }
  else { float r = min( uArea.z, uArea.w ); sd = ( length( q / uArea.zw ) - 1.0 ) * r; }
  return 1.0 - smoothstep( - max( uAreaCfg.y, 1e-3 ), 0.0, sd );
}

float gExclusion( vec2 p ) {
  float k = 1.0;
  for ( int i = 0; i < MAX_EXCL; i ++ ) {
    if ( i >= uExclCount ) break;
    vec4 A = uExcl[ 2 * i ]; vec4 B = uExcl[ 2 * i + 1 ];
    vec2 a = A.xy; vec2 ab = A.zw - A.xy;
    float len2 = max( dot( ab, ab ), 1e-8 );
    float sd;
    if ( B.z < 0.5 ) {
      float t = clamp( dot( p - a, ab ) / len2, 0.0, 1.0 );
      sd = length( p - a - ab * t ) - B.x;
    } else {
      float L = sqrt( len2 ); vec2 u = ab / L; vec2 q = p - ( a + ab * 0.5 );
      vec2 d = abs( vec2( dot( q, u ), dot( q, vec2( - u.y, u.x ) ) ) ) - vec2( L * 0.5, B.x );
      sd = length( max( d, 0.0 ) ) + min( max( d.x, d.y ), 0.0 );
    }
    k *= smoothstep( 0.0, max( B.y, 1e-3 ), sd );
  }
  return k;
}
`

const VERT_MAIN = /* glsl */ `
vec3 gPos = vec3( 0.0 );
vec3 objectNormal = vec3( 0.0, 1.0, 0.0 );
bool gCulled = true;
vGAlbedo = vec3( 0.0 );
vGData = vec4( 0.0 );
{
  int ring = int( position.z + 0.5 );
  vec4 RA = uRingA[ ring ];
  vec4 RB = uRingB[ ring ];
  int W = max( int( RA.z + 0.5 ), 1 );
  ivec2 cell = ivec2( int( RA.x ) + gl_InstanceID % W, int( RA.y ) + gl_InstanceID / W );
  uint h0 = gPcg( uint( cell.x ) * 1597334677u ^ gPcg( uint( cell.y ) + uint( uBlade2.z ) + uint( ring ) * 2654435769u ) );
  uint h1 = gPcg( h0 ); uint h2 = gPcg( h1 ); uint h3 = gPcg( h2 );
  vec2 jit = vec2( gU01( h0 ), gU01( h1 ) ) - 0.5;
  vec2 rootXZ = ( vec2( cell ) + 0.5 + jit * 1.4 ) * RA.w;
  vec2 dxz = rootXZ - cameraPosition.xz;
  float rOut = RB.y + RB.w;
  if ( dot( dxz, dxz ) < rOut * rOut ) {
    vec2 grad; float inside;
    float groundY = gHeightAt( rootXZ, grad, inside );
    vec3 root = vec3( rootXZ.x, groundY - uBlade3.z, rootXZ.y );
    float d = distance( root, cameraPosition );
    // ring membership: stochastic crossfade between rings, and the field's outer fade
    float wIn = ring == 0 ? 1.0 : smoothstep( RB.x - RB.z, RB.x + RB.z, d );
    float wOut = 1.0 - smoothstep( RB.y - RB.w, RB.y + RB.w, d );
    float w = wIn * wOut;
    float keep = gU01( h3 );
    // density: mask texture × patch area × exclusions (paths, footprints)
    float m = inside * uMaskCfg.y;
    if ( uMaskCfg.x > 0.5 ) {
      vec2 muv = ( rootXZ - uMaskRect.xy ) * uMaskRect.zw;
      float mm = dot( texture( uMaskTex, clamp( muv, 0.0, 1.0 ) ), uMaskChan );
      m *= ( muv.x >= 0.0 && muv.x <= 1.0 && muv.y >= 0.0 && muv.y <= 1.0 ) ? mm : 0.0;
    }
    if ( uAreaCfg.x > 0.5 ) m *= gArea( rootXZ );
    if ( uExclCount > 0 && m > 0.0 ) m *= gExclusion( rootXZ );
    // spatial patches: tall/short and colour vary over metres, not per blade
    vec4 n0 = texture( uNoise, rootXZ * ( 1.0 / 65.0 ) + vec2( 0.37, 0.61 ) );
    // colour patches: two decorrelated taps (rotated, ~patchSize and 65 m) so dry/lush areas read as
    // irregular blobs instead of the parallel bands a single sum-of-sines tap shows from above
    float pA = texture( uNoise, mat2( 0.62, 0.78, - 0.78, 0.62 ) * rootXZ * uColCfg2.x + vec2( 0.11, 0.83 ) ).g;
    float posNoise = clamp( 0.5 + ( pA + n0.a - 1.0 ) * 0.75, 0.0, 1.0 );
    float scale0 = mix( uBlade.y, uBlade.z, n0.b * n0.b );
    float scale = scale0 * m * smoothstep( 0.0, 0.12, w - keep );
    float bladeLen = scale * BLADE_HEIGHT * uBlade.x;
    // frustum test on a sphere around the (possibly bent) blade
    vec3 ctr = root + vec3( 0.0, bladeLen * 0.45, 0.0 );
    float rad = bladeLen * 0.85 + 0.25 * uBlade.x;
    vec4 c = projectionMatrix * ( viewMatrix * vec4( ctr, 1.0 ) );
    float wp = max( c.w, 1e-4 );
    bool inFrustum = c.w > - rad && abs( c.x ) < wp + rad * projectionMatrix[ 0 ][ 0 ] && abs( c.y ) < wp + rad * projectionMatrix[ 1 ][ 1 ];
    if ( keep < w && scale0 * m > 0.11 && inFrustum ) {
      gCulled = false;
      float side = position.x;
      float hh = position.y;
      float bladeHash = gU01( h2 );
      // ---- wind: gust field advected along the wind with coverage/lull shaping, rare strong events
      vec2 dir = uWindDir; vec2 perp = vec2( - dir.y, dir.x );
      float lag = ( 1.2 - posNoise ) * 0.5 * fract( bladeHash * 7.31 );
      vec2 scrollDir = perp * 0.3717 - dir;
      vec4 gn = texture( uNoise, rootXZ * uWindA.z + scrollDir * ( uWindA.y * ( uTime - lag ) ) );
      float fastGust = sin( gn.g * 18.85 ) * 0.5 + 0.5;
      float field = mix( gn.r, fastGust, uWindA.w );
      float gStart = 1.0 - uWindB.y;
      float gust = smoothstep( gStart, gStart + 0.25, field );
      float windFactor = uWindA.x * mix( uWindB.x, 1.0, gust ) * mix( 1.0, 4.0, uWindA.w );
      float veer = ( gn.g - 0.5 ) * 2.0 * uWindB.z;
      vec2 windXZ = clamp( ( dir + perp * veer ) * windFactor, - 2.0, 2.0 );
      // response: cubic Bezier over blade scale — tall blades ride the wind, short ones stay planted
      float tS = clamp( scale / uBlade.z, 0.0, 1.0 ); float inv = 1.0 - tS;
      float resp = 3.0 * inv * inv * tS * uBend.y + 3.0 * inv * tS * tS * uBend.z + tS * tS * tS;
      float instanceNoise = bladeHash * 0.25 - 0.125;
      float spriteNoise = fract( bladeHash * 31.7 ) * 2.0 - 1.0;
      float windNoiseFactor = max( clamp( dot( windXZ, windXZ ) * 3.5, 0.0, 1.0 ), smoothstep( 0.2, 1.0, gust ) * 0.45 );
      float swayEnv = mix( 0.75, 1.35, windNoiseFactor );
      float randomPhase = instanceNoise * 25.13;
      float heightPhase = swayEnv * 0.55;
      float swayRate = spriteNoise * 0.375 + 1.075;
      float swayA = sin( uTime * swayRate * 1.35 + randomPhase + heightPhase );
      float swayB = sin( uTime * swayRate * 2.15 + rootXZ.x * 0.17 + rootXZ.y * 0.11 + randomPhase * 1.7 + heightPhase * 1.6 ) * 0.45;
      float bladeAngle = fract( bladeHash * 53.3 ) * 6.28318;
      vec2 restDir = vec2( cos( bladeAngle ), sin( bladeAngle ) );
      vec2 ambient = restDir * ( ( swayA + swayB ) * uWindB.w * swayEnv );
      float bendStrength = uBend.x * resp;
      float flutterPhase = fract( bladeHash * 97.13 ) * 6.28318 + rootXZ.x * 0.13 + rootXZ.y * 0.07;
      float flutter = sin( uTime * uWindA.y * 1.7 + flutterPhase * 1.3 + heightPhase * 2.2 ) * 0.025 * windNoiseFactor * bendStrength;
      vec2 bend = ( windXZ * bendStrength + ambient * resp + perp * flutter ) * uBlade.x;
      // ---- blade: cylindrical billboard, flare-and-taper width, per-vertex curl, bend with tip drop
      vec3 tc = root - cameraPosition;
      vec2 rxz = vec2( tc.z, - tc.x ); float rl = length( rxz );
      vec3 right = rl > 1e-4 ? vec3( rxz.x, 0.0, rxz.y ) / rl : vec3( 1.0, 0.0, 0.0 );
      float widthGain = mix( 1.0, uBlade2.w, smoothstep( 0.18 * uField.x, 0.7 * uField.x, d ) ) * pow( RA.w / uBlade3.x, uBlade3.y );
      float profile = min( 1.0, hh / 0.26 * 0.72 + 0.28 ) * pow( 1.0 - hh, 1.22 );
      float halfW = profile * BLADE_WIDTH * 0.5 * ( posNoise + 0.5 ) * scale * uBlade.x * uBlade.w * widthGain;
      float bendW = hh * hh;
      float roll = spriteNoise * uBlade2.y + ( ( posNoise - 0.5 ) * 0.25 + instanceNoise ) * bendW * uBend.x;
      float px = side * halfW; float py = hh * bladeLen;
      float cr = cos( roll ); float sr = sin( roll );
      float rx = px * cr - py * sr; float ry = px * sr + py * cr;
      float bendShape = uBend.w * 2.0 * hh * ( 1.0 - hh ) + bendW;
      float drop = dot( bend, bend ) / max( bladeLen * 2.0, 1e-3 ) * uBlade2.x;
      gPos = root + right * rx + vec3( bend.x * bendShape, ry - drop * bendShape, bend.y * bendShape );
      // ---- shading inputs: resting normal tilting skyward toward the tip, converging on the ground
      // normal (and the ground colour) in the far field so the meadow ends in matching turf
      float far = smoothstep( uField.z, uField.w, d );
      vec3 nGround = normalize( vec3( - grad.x, 1.0, - grad.y ) );
      vec3 nBlade = normalize( vec3( restDir.x, 0.25 + 0.75 * hh, restDir.y ) );
      objectNormal = normalize( mix( nBlade, nGround, far ) );
      float colorVar = mix( 1.0, posNoise, uColCfg.y );
      vec3 green = mix( uColDark, uColBase, colorVar );
      float rustMask = posNoise * ( 1.0 - posNoise ) * 4.0 * uColCfg.w;
      float warmMask = clamp( ( posNoise - 0.6 ) * 2.5, 0.0, 1.0 ) * uColCfg.z;
      vec3 col = mix( mix( green, uColRust, rustMask ), uColWarm, warmMask );
      col = mix( col, uColTip, smoothstep( 0.25, 1.0, hh ) * uColCfg.x );
      col *= 0.9 + 0.2 * fract( bladeHash * 13.7 );
      col = mix( col, uColGround, far );
      // travelling gusts lift the sheen of the blades they lean over (visible across the whole field)
      col *= 1.0 + uBlade3.w * gust * ( 0.4 + 0.6 * hh ) * wOut * min( uWindA.x / 0.32, 1.5 );
      vGAlbedo = col;
      vGData = vec4( hh, far, smoothstep( 0.1, 0.9, hh ) * ( 1.0 - far ), 0.0 );
    }
  }
}
`

const FRAG_PARS = /* glsl */ `
varying vec3 vGAlbedo;
varying vec4 vGData;
uniform vec4 uShade;     // rootAO, rootSkyVisibility, translucency, diffuseContrast
uniform vec3 uSunDir;    // fallback sun (world, toward the sun) when the scene has no DirectionalLight
uniform vec3 uSunRad;
`

const FRAG_RE = /* glsl */ `
// Blade canopy response to a direct light: soft two-sided wrap (thin leaves light from both sides),
// root occlusion, and transmission when looking toward the light. Converges to plain Lambert on the
// ground normal in the far field so blades and the turf beyond them read as one surface.
void RE_Direct_Grass( const in IncidentLight directLight, const in vec3 geometryPosition, const in vec3 geometryNormal, const in vec3 geometryViewDir, const in vec3 geometryClearcoatNormal, const in LambertMaterial material, inout ReflectedLight reflectedLight ) {
  float h = vGData.x; float far = vGData.y;
  float ndl = dot( geometryNormal, directLight.direction );
  float horizon = smoothstep( - 0.03, 0.2, dot( directLight.direction, viewMatrix[ 1 ].xyz ) );
  float canopy = mix( 0.35, 1.0, mix( 0.65, abs( ndl ), uShade.w ) ) * horizon;
  float resp = mix( canopy, saturate( ndl ), far );
  float ao = mix( mix( uShade.x, 1.0, smoothstep( 0.0, 0.6, h ) ), 1.0, far );
  reflectedLight.directDiffuse += directLight.color * ( resp * ao ) * BRDF_Lambert( material.diffuseColor );
  float align = saturate( dot( geometryViewDir, - directLight.direction ) );
  float lobe = 0.3 * ( 0.5 + 0.5 * align ) + 0.7 * pow( align, 4.0 );
  vec3 transColor = mix( material.diffuseColor * 1.6, vec3( 0.45, 0.5, 0.2 ), 0.35 );
  reflectedLight.directDiffuse += directLight.color * RECIPROCAL_PI * transColor * ( lobe * horizon * vGData.z * uShade.z );
}
#undef RE_Direct
#define RE_Direct RE_Direct_Grass
`

const FRAG_SUN_FALLBACK = /* glsl */ `
#if NUM_DIR_LIGHTS == 0
if ( uSunRad.r + uSunRad.g + uSunRad.b > 0.0 ) {
  IncidentLight gSun;
  gSun.color = uSunRad;
  gSun.direction = normalize( mat3( viewMatrix ) * uSunDir );
  gSun.visible = true;
  RE_Direct_Grass( gSun, geometryPosition, geometryNormal, geometryViewDir, geometryClearcoatNormal, material, reflectedLight );
}
#endif
`

const FRAG_AO = /* glsl */ `
reflectedLight.indirectDiffuse *= mix( mix( uShade.y, 1.0, vGData.x ) * mix( uShade.x, 1.0, smoothstep( 0.0, 0.6, vGData.x ) ), 1.0, vGData.y );
`

// single-apex blade strip: x = side (−1/+1), y = height fraction, z = ring index
function makeBladeGeometry(segments, ring) {
  const positions = new Float32Array((segments * 2 + 1) * 3)
  for (let r = 0; r < segments; r++) {
    const h = r / segments
    positions.set([-1, h, ring], r * 6)
    positions.set([1, h, ring], r * 6 + 3)
  }
  positions.set([0, 1, ring], segments * 6)
  const indices = []
  for (let r = 0; r < segments - 1; r++) {
    const a = r * 2, b = a + 1, c = a + 2, d = a + 3
    indices.push(a, b, c, b, d, c)
  }
  indices.push(segments * 2 - 2, segments * 2 - 1, segments * 2)
  const geo = new THREE.InstancedBufferGeometry()
  geo.setAttribute('position', new THREE.BufferAttribute(positions, 3))
  geo.setAttribute('normal', new THREE.BufferAttribute(new Float32Array(positions.length), 3))
  geo.setIndex(indices)
  geo.instanceCount = 0
  geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 0)
  geo.boundingBox = new THREE.Box3() // empty: out of editor framing / picking boxes
  return geo
}

export function createGrass(options = {}) {
  const t0 = performance.now()
  const o = {
    height: 1.0, density: 1.0, radius: 100, dryness: 0.2, patchSize: 100, seed: 1, y: 0,
    translucency: 1, rootAO: 0.45, maskChannel: undefined, heightChannel: 0, maxInstances: 1500000,
    ...options,
  }
  const wind = { strength: 0.32, speed: 0.18, direction: [1, 0.2], coverage: 0.6, events: 1, eddy: 0.9, sway: 0.055, ...(options.wind || {}) }
  const noise = makeNoiseTexture()
  const noiseSampler = makeSampler(noise, 1, true), scaleSampler = makeSampler(noise, 2, true), spareSampler = makeSampler(noise, 3, true)
  const owned = [noise]

  // ---- ground: height texture (given, or baked from heightAt), else flat
  let heightTex = o.heightTexture || null
  let bounds = o.bounds || null
  if (!heightTex && o.heightAt) {
    bounds = bounds || { minX: -256, minZ: -256, maxX: 256, maxZ: 256 }
    const span = Math.max(bounds.maxX - bounds.minX, bounds.maxZ - bounds.minZ)
    heightTex = bake(o.heightAt, bounds, Math.min(1024, Math.max(64, Math.ceil(span / 0.75))), false)
    heightTex.name = 'grass.height'
    owned.push(heightTex)
  }
  const heightSampler = heightTex && !o.heightAt ? makeSampler(heightTex, o.heightChannel) : null
  const groundAt = (x, z) => {
    if (o.heightAt) return o.heightAt(x, z)
    if (heightSampler && bounds) return heightSampler((x - bounds.minX) / (bounds.maxX - bounds.minX), (z - bounds.minZ) / (bounds.maxZ - bounds.minZ))
    return o.y
  }

  // ---- density mask (terrain.heightTexture carries the grass density in A: used unless a mask is given)
  if (o.mask === undefined && o.heightTexture?.name === 'terrain-height') o.mask = o.heightTexture
  let maskTex = null, maskBounds = o.maskBounds || bounds, maskScalar = 1, maskChannel = o.maskChannel ?? 0
  if (typeof o.mask === 'number') maskScalar = o.mask
  else if (typeof o.mask === 'function') {
    maskBounds = maskBounds || { minX: -256, minZ: -256, maxX: 256, maxZ: 256 }
    const span = Math.max(maskBounds.maxX - maskBounds.minX, maskBounds.maxZ - maskBounds.minZ)
    maskTex = bake(o.mask, maskBounds, Math.min(1024, Math.max(64, Math.ceil(span / 0.5))), true)
    maskTex.name = 'grass.mask'
    owned.push(maskTex); maskChannel = 0
  } else if (o.mask?.isTexture) {
    maskTex = o.mask
    if (o.maskChannel === undefined && o.mask === o.heightTexture) maskChannel = 3
  } else if (o.mask?.texture) {
    maskTex = o.mask.texture; maskBounds = o.mask.bounds || maskBounds; maskChannel = o.mask.channel ?? maskChannel
  }
  if (maskTex && !maskBounds) throw new Error('createGrass: a mask texture needs bounds')
  const maskSampler = maskTex ? makeSampler(maskTex, maskChannel) : null
  const chan = (i) => new THREE.Vector4(i === 0 ? 1 : 0, i === 1 ? 1 : 0, i === 2 ? 1 : 0, i === 3 ? 1 : 0)
  const rect = (b) => (b ? new THREE.Vector4(b.minX, b.minZ, 1 / (b.maxX - b.minX), 1 / (b.maxZ - b.minZ)) : new THREE.Vector4(0, 0, 1, 1))

  // ---- uniforms (shared by the three ring meshes through one material)
  const placeholder = new THREE.DataTexture(new Float32Array(4), 1, 1, THREE.RGBAFormat, THREE.FloatType)
  placeholder.needsUpdate = true
  owned.push(placeholder)
  const U = {
    uTime: { value: 0 },
    uWindDir: { value: new THREE.Vector2(1, 0) },
    uWindA: { value: new THREE.Vector4() },
    uWindB: { value: new THREE.Vector4() },
    uBend: { value: new THREE.Vector4(2.5, 0.003, 0.85, 0.4) },
    uBlade: { value: new THREE.Vector4(1, 0.52, 1.3, 1) },
    uBlade2: { value: new THREE.Vector4(1.3, 0.05, (o.seed >>> 0) % 16777216, 2.2) },
    uBlade3: { value: new THREE.Vector4(BASE_SPACING, 0.55, 0.04, 0.14) },
    uNoise: { value: noise },
    uHeightTex: { value: heightTex || placeholder },
    uHeightRect: { value: rect(bounds) },
    uHeightCfg: { value: new THREE.Vector4(heightTex ? 1 : 0, o.y, o.outside === 'keep' ? 1 : 0, 0) },
    uHeightChan: { value: chan(o.heightChannel) },
    uMaskTex: { value: maskTex || placeholder },
    uMaskRect: { value: rect(maskBounds) },
    uMaskCfg: { value: new THREE.Vector4(maskTex ? 1 : 0, maskScalar, 0, 0) },
    uMaskChan: { value: chan(maskChannel) },
    uArea: { value: new THREE.Vector4() },
    uAreaCfg: { value: new THREE.Vector4() },
    uExcl: { value: Array.from({ length: MAX_EXCL * 2 }, () => new THREE.Vector4()) },
    uExclCount: { value: 0 },
    uRingA: { value: RINGS.map(() => new THREE.Vector4()) },
    uRingB: { value: RINGS.map(() => new THREE.Vector4()) },
    uField: { value: new THREE.Vector4() },
    uColDark: { value: new THREE.Color() }, uColBase: { value: new THREE.Color() }, uColTip: { value: new THREE.Color() },
    uColWarm: { value: new THREE.Color() }, uColRust: { value: new THREE.Color() }, uColGround: { value: new THREE.Color() },
    uColCfg: { value: new THREE.Vector4(0.4, 0.9, 0.4, 0.08) },
    uColCfg2: { value: new THREE.Vector4(1 / (o.patchSize || 100), 0, 0, 0) },
    uShade: { value: new THREE.Vector4(0.45, 0.6, 0.18, 0.5) },
    uSunDir: { value: new THREE.Vector3(0.4, 0.55, 0.6).normalize() },
    uSunRad: { value: new THREE.Color(0, 0, 0) },
  }

  const material = new THREE.MeshLambertMaterial({ name: 'Grass blades', side: THREE.DoubleSide })
  material.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, U)
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\n' + VERT_PARS)
      .replace('#include <beginnormal_vertex>', VERT_MAIN)
      .replace('#include <defaultnormal_vertex>', 'vec3 transformedNormal = mat3( viewMatrix ) * objectNormal;')
      .replace('#include <begin_vertex>', 'vec3 transformed = gPos;')
      .replace('#include <project_vertex>', 'vec4 mvPosition = viewMatrix * vec4( transformed, 1.0 );\ngl_Position = projectionMatrix * mvPosition;\nif ( gCulled ) gl_Position = vec4( 0.0, 0.0, 2.0, 1.0 );')
      .replace('#include <worldpos_vertex>', '#if defined( USE_ENVMAP ) || defined( DISTANCE ) || defined ( USE_SHADOWMAP ) || defined ( USE_TRANSMISSION ) || NUM_SPOT_LIGHT_COORDS > 0\nvec4 worldPosition = vec4( transformed, 1.0 );\n#endif')
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', '#include <common>\n' + FRAG_PARS)
      .replace('#include <color_fragment>', '#include <color_fragment>\ndiffuseColor.rgb *= vGAlbedo;')
      .replace('#include <normal_fragment_begin>', 'float faceDirection = gl_FrontFacing ? 1.0 : - 1.0;\nvec3 normal = normalize( vNormal );\nvec3 nonPerturbedNormal = normal;')
      .replace('#include <lights_lambert_pars_fragment>', '#include <lights_lambert_pars_fragment>\n' + FRAG_RE)
      .replace('#include <lights_fragment_end>', FRAG_SUN_FALLBACK + '#include <lights_fragment_end>\n' + FRAG_AO)
  }
  material.customProgramCacheKey = () => 'edit3d-grass-v1'

  const object = new THREE.Group()
  object.name = 'Grass'
  const meshes = RINGS.map((ring, k) => {
    const mesh = new THREE.Mesh(makeBladeGeometry(ring.seg, k), material)
    mesh.name = `Grass LOD${k}`
    mesh.frustumCulled = false
    mesh.receiveShadow = true
    mesh.castShadow = false
    mesh.matrixAutoUpdate = false
    mesh.raycast = () => {}
    mesh.onBeforeRender = (renderer, scene, camera) => prepare(camera, renderer)
    object.add(mesh)
    return mesh
  })

  // ---- live parameters
  const groundColor = new THREE.Color()
  const params = { height: o.height, density: o.density, radius: o.radius, dryness: o.dryness, translucency: o.translucency, colors: o.colors || {}, wind }
  let schedule = makeWindSchedule(o.seed)
  let baseAngle = 0

  function applyColors() {
    const d = THREE.MathUtils.clamp(params.dryness, 0, 1)
    const [A, B, t] = d < 0.2 ? [PALETTE_LUSH, PALETTE_TEMPLATE, d / 0.2] : [PALETTE_TEMPLATE, PALETTE_DRY, (d - 0.2) / 0.8]
    const pick = (k) => params.colors[k] !== undefined ? toLinearColor(params.colors[k]) : toLinearColor(A[k].map((v, i) => v + (B[k][i] - v) * t))
    U.uColDark.value.copy(pick('dark')); U.uColBase.value.copy(pick('base')); U.uColTip.value.copy(pick('tip'))
    U.uColWarm.value.copy(pick('warm')); U.uColRust.value.copy(pick('rust'))
    U.uColCfg.value.z = 0.3 + 0.2 * d // warm patches: 0.34 at the default (the composed world's meadow)
    // ground colour = mean blade albedo over the patch-noise distribution, tip ramp and root occlusion,
    // which is what the far blades converge to (they shade as plain Lambert of this colour)
    const c = U.uColCfg.value, acc = new THREE.Color(0, 0, 0), tmp = new THREE.Color()
    const N = 40, inv = U.uColCfg2.value.x
    let n = 0
    for (let j = 0; j < N; j++) for (let i = 0; i < N; i++) {
      const x = (i + 0.5) * 9.7, z = (j + 0.5) * 9.7 // 390 m square: several periods of both taps
      const pA = noiseSampler((0.62 * x - 0.78 * z) * inv + 0.11, (0.78 * x + 0.62 * z) * inv + 0.83)
      const p = Math.min(Math.max(0.5 + (pA + spareSampler(x / 65 + 0.37, z / 65 + 0.61) - 1) * 0.75, 0), 1)
      tmp.copy(U.uColDark.value).lerp(U.uColBase.value, 1 + (p - 1) * c.y)
      tmp.lerp(U.uColRust.value, p * (1 - p) * 4 * c.w).lerp(U.uColWarm.value, Math.min(Math.max((p - 0.6) * 2.5, 0), 1) * c.z)
      acc.add(tmp); n++
    }
    acc.multiplyScalar(1 / n)
    groundColor.copy(acc).lerp(U.uColTip.value, 0.35 * c.x).multiplyScalar(0.82)
    U.uColGround.value.copy(groundColor)
  }

  function applyShape() {
    const size = params.height / (MEAN_SCALE * BLADE_HEIGHT)
    U.uBlade.value.x = size
    // short grass reads thin at the same spacing: widen relatively as blades shorten
    U.uBlade.value.w = Math.pow(Math.max(size, 0.05), -0.35)
    U.uBlade3.value.x = BASE_SPACING / Math.sqrt(Math.max(params.density, 0.05))
    U.uBlade3.value.z = 0.04 * size
    U.uShade.value.z = 0.18 * params.translucency
  }

  function applyWind() {
    const w = params.wind
    let dir = w.direction
    if (typeof dir === 'number') dir = [Math.cos(THREE.MathUtils.degToRad(dir)), Math.sin(THREE.MathUtils.degToRad(dir))]
    baseAngle = Math.atan2(dir[1], dir[0])
    U.uWindA.value.set(w.strength, w.speed, w.uvScale ?? 0.0135, 0)
    U.uWindB.value.set(w.lull ?? 0.09, w.coverage, w.eddy, w.sway)
    lastTime = NaN
    update(currentTime)
  }

  let currentTime = o.time ?? 8, lastTime = NaN
  function update(time) {
    currentTime = time
    if (time === lastTime) return
    lastTime = time
    const s = schedule(time)
    const a = baseAngle + s.veer
    U.uTime.value = time
    U.uWindDir.value.set(Math.cos(a), Math.sin(a))
    U.uWindA.value.w = THREE.MathUtils.smoothstep(s.level, 0.6, 0.98) * (params.wind.events ?? 1)
  }

  // ---- exclusions and patch area
  function setExclusions(list = []) {
    const out = []
    for (const e of list) {
      const feather = e.feather ?? 0.6
      if (e.path) {
        const hw = (e.width ?? 1.5) / 2
        for (let i = 0; i + 1 < e.path.length; i++) out.push([e.path[i][0], e.path[i][1], e.path[i + 1][0], e.path[i + 1][1], hw, feather, 0])
        if (e.path.length === 1) out.push([e.path[0][0], e.path[0][1], e.path[0][0], e.path[0][1], hw, feather, 0])
      } else if (e.circle) out.push([e.circle[0], e.circle[1], e.circle[0], e.circle[1], e.circle[2], feather, 0])
      else if (e.rect) {
        const [cx, cz, w, d] = e.rect, a = e.angle || 0, ux = Math.cos(a), uz = -Math.sin(a)
        out.push([cx - ux * w / 2, cz - uz * w / 2, cx + ux * w / 2, cz + uz * w / 2, d / 2, feather, 1])
      }
    }
    if (out.length > MAX_EXCL) console.warn(`createGrass: ${out.length} exclusion shapes, only the first ${MAX_EXCL} apply`)
    const n = Math.min(out.length, MAX_EXCL)
    for (let i = 0; i < n; i++) {
      const s = out[i]
      U.uExcl.value[2 * i].set(s[0], s[1], s[2], s[3])
      U.uExcl.value[2 * i + 1].set(s[4], s[5], s[6], 0)
    }
    U.uExclCount.value = n
    exclShapes = out.slice(0, n)
  }
  let exclShapes = []
  let areaBox = null
  function setArea(area) {
    if (!area) { U.uAreaCfg.value.set(0, 0, 1, 0); areaBox = null; return }
    const [cx, cz] = area.center || [0, 0]
    const ellipse = area.radius !== undefined || area.shape === 'ellipse'
    const hx = area.radius ?? area.size[0] / 2, hz = area.radius ?? area.size[1] / 2
    const a = area.angle || 0
    U.uArea.value.set(cx, cz, hx, hz)
    U.uAreaCfg.value.set(ellipse ? 2 : 1, area.feather ?? 0.5, Math.cos(a), Math.sin(a))
    const ex = Math.abs(Math.cos(a)) * hx + Math.abs(Math.sin(a)) * hz, ez = Math.abs(Math.sin(a)) * hx + Math.abs(Math.cos(a)) * hz
    areaBox = { minX: cx - ex, maxX: cx + ex, minZ: cz - ez, maxZ: cz + ez }
  }

  // ---- per-render domain: which world cells each ring covers for THIS camera (uniforms only, so it
  // applies to the draw that is about to happen — edit-mode on-demand renders and every viewport)
  const _p = new THREE.Vector3(), _cam = new THREE.Vector3(), _corners = []
  for (let i = 0; i < 8; i++) _corners.push(new THREE.Vector3())
  let prepKey = ''
  const lastDomain = RINGS.map(() => ({ count: 0 }))
  let warned = false
  function prepare(camera, renderer) {
    const e = camera.matrixWorld.elements, pe = camera.projectionMatrix.elements
    const key = `${renderer?.info?.render?.frame}|${camera.id}|${e[12]},${e[13]},${e[14]},${e[8]},${e[9]},${e[10]},${pe[0]},${pe[5]}|${params.radius}|${U.uBlade3.value.x}|${U.uBlade.value.x}`
    if (key === prepKey) return
    prepKey = key
    _cam.setFromMatrixPosition(camera.matrixWorld)
    const alt = Math.max(0, _cam.y - groundAt(_cam.x, _cam.z))
    const R = params.radius * Math.min(1 + alt / 120, 3)
    const fade = 0.25
    U.uField.value.set(R, 0, 0.25 * R, 0.95 * R)
    const reach = 2.4 * U.uBlade.value.x * U.uBlade.value.z + 0.5 // blade length + bend
    const persp = !camera.isOrthographicCamera
    const inv = camera.projectionMatrixInverse
    let total = 0
    for (let k = 0; k < RINGS.length; k++) {
      const ring = RINGS[k]
      const r0 = k === 0 ? 0 : RINGS[k - 1].outer * R
      const last = k === RINGS.length - 1
      const r1 = last ? R * (1 - fade / 2) : ring.outer * R
      const bandIn = k === 0 ? 0 : 0.12 * r0
      const bandOut = last ? R * fade / 2 : 0.12 * r1
      const s = U.uBlade3.value.x * ring.spacing
      const depth = r1 + bandOut + reach
      // frustum truncated at `depth`, projected onto XZ
      let minX = _cam.x, maxX = _cam.x, minZ = _cam.z, maxZ = _cam.z
      let i = 0
      for (const sx of [-1, 1]) for (const sy of [-1, 1]) {
        _p.set(sx, sy, -1).applyMatrix4(inv)
        const near = _corners[i++].copy(_p)
        const farP = _corners[i++]
        if (persp) farP.copy(_p).multiplyScalar(depth / Math.max(-_p.z, 1e-6))
        else farP.set(_p.x, _p.y, -depth)
        for (const q of [near, farP]) {
          q.applyMatrix4(camera.matrixWorld)
          minX = Math.min(minX, q.x); maxX = Math.max(maxX, q.x); minZ = Math.min(minZ, q.z); maxZ = Math.max(maxZ, q.z)
        }
      }
      const lim = r1 + bandOut + reach
      minX = Math.max(minX - reach, _cam.x - lim); maxX = Math.min(maxX + reach, _cam.x + lim)
      minZ = Math.max(minZ - reach, _cam.z - lim); maxZ = Math.min(maxZ + reach, _cam.z + lim)
      if (areaBox) { minX = Math.max(minX, areaBox.minX - s); maxX = Math.min(maxX, areaBox.maxX + s); minZ = Math.max(minZ, areaBox.minZ - s); maxZ = Math.min(maxZ, areaBox.maxZ + s) }
      if (heightTex && bounds && o.outside !== 'keep') { minX = Math.max(minX, bounds.minX - s); maxX = Math.min(maxX, bounds.maxX + s); minZ = Math.max(minZ, bounds.minZ - s); maxZ = Math.min(maxZ, bounds.maxZ + s) }
      let count = 0, ix0 = 0, iz0 = 0, W = 1
      if (maxX > minX && maxZ > minZ && (k === 0 || r0 - bandIn < R)) {
        ix0 = Math.floor(minX / s); iz0 = Math.floor(minZ / s)
        W = Math.floor(maxX / s) - ix0 + 1
        const H = Math.floor(maxZ / s) - iz0 + 1
        count = W * H
        if (count > o.maxInstances) {
          if (!warned) { console.warn(`createGrass: ring ${k} wants ${count} blades, capped at ${o.maxInstances} (lower density or radius)`); warned = true }
          count = o.maxInstances
        }
      }
      U.uRingA.value[k].set(ix0, iz0, W, s)
      U.uRingB.value[k].set(r0, r1, bandIn, bandOut)
      meshes[k].geometry.instanceCount = count
      lastDomain[k] = { count, ix0, iz0, W, s, r0, r1, bandIn, bandOut }
      total += count
    }
    return total
  }

  // CPU replica of the vertex-stage culling (no wind) — exact enough to report blades/triangles drawn
  const _frustum = new THREE.Frustum(), _mat = new THREE.Matrix4(), _sphere = new THREE.Sphere()
  function stats(camera) {
    camera.updateMatrixWorld()
    prepKey = ''
    prepare(camera, null)
    prepKey = ''
    _frustum.setFromProjectionMatrix(_mat.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse))
    const cam = new THREE.Vector3().setFromMatrixPosition(camera.matrixWorld)
    const B = U.uBlade.value, seed = U.uBlade2.value.z, sink = U.uBlade3.value.z
    const out = { rings: [], blades: 0, triangles: 0, instances: 0 }
    for (let k = 0; k < RINGS.length; k++) {
      const D = lastDomain[k]
      let drawn = 0
      for (let id = 0; id < D.count; id++) {
        const cx = D.ix0 + (id % D.W), cz = D.iz0 + Math.floor(id / D.W)
        const h0 = pcg((Math.imul(cx, 1597334677) ^ pcg((cz + seed + Math.imul(k, 2654435769)) >>> 0)) >>> 0)
        const h1 = pcg(h0), h2 = pcg(h1), h3 = pcg(h2)
        const x = (cx + 0.5 + (u01(h0) - 0.5) * 1.4) * D.s, z = (cz + 0.5 + (u01(h1) - 0.5) * 1.4) * D.s
        const dx = x - cam.x, dz = z - cam.z, rOut = D.r1 + D.bandOut
        if (dx * dx + dz * dz >= rOut * rOut) continue
        let inside = 1
        if (heightTex && bounds && o.outside !== 'keep') inside = x >= bounds.minX && x <= bounds.maxX && z >= bounds.minZ && z <= bounds.maxZ ? 1 : 0
        const y = groundAt(x, z) - sink
        const d = Math.hypot(dx, y - cam.y, dz)
        const ss = (a, b, v) => { const t = Math.min(Math.max((v - a) / (b - a || 1e-6), 0), 1); return t * t * (3 - 2 * t) }
        const w = (k === 0 ? 1 : ss(D.r0 - D.bandIn, D.r0 + D.bandIn, d)) * (1 - ss(D.r1 - D.bandOut, D.r1 + D.bandOut, d))
        const keep = u01(h3)
        if (keep >= w) continue
        let m = inside * maskScalar
        if (maskSampler) {
          const u = (x - maskBounds.minX) / (maskBounds.maxX - maskBounds.minX), v = (z - maskBounds.minZ) / (maskBounds.maxZ - maskBounds.minZ)
          m *= u >= 0 && u <= 1 && v >= 0 && v <= 1 ? maskSampler(u, v) : 0
        }
        if (m <= 0) continue
        if (areaBox) m *= areaCpu(x, z)
        if (m > 0 && exclShapes.length) m *= exclCpu(x, z)
        const nb = scaleSampler(x / 65 + 0.37, z / 65 + 0.61)
        const scale0 = B.y + (B.z - B.y) * nb * nb
        if (scale0 * m <= 0.11) continue
        const len = scale0 * m * BLADE_HEIGHT * B.x
        _sphere.center.set(x, y + len * 0.45, z); _sphere.radius = len * 0.85 + 0.25 * B.x
        if (!_frustum.intersectsSphere(_sphere)) continue
        drawn++
      }
      const tris = drawn * (RINGS[k].seg * 2 - 1)
      out.rings.push({ segments: RINGS[k].seg, instances: D.count, blades: drawn, triangles: tris })
      out.blades += drawn; out.triangles += tris; out.instances += D.count
    }
    return out
  }
  function areaCpu(x, z) {
    const a = U.uArea.value, c = U.uAreaCfg.value
    let qx = x - a.x, qz = z - a.y
    const rx = qx * c.z + qz * c.w, rz = -qx * c.w + qz * c.z
    let sd
    if (c.x < 1.5) { const dx = Math.abs(rx) - a.z, dz = Math.abs(rz) - a.w; sd = Math.hypot(Math.max(dx, 0), Math.max(dz, 0)) + Math.min(Math.max(dx, dz), 0) }
    else sd = (Math.hypot(rx / a.z, rz / a.w) - 1) * Math.min(a.z, a.w)
    const t = Math.min(Math.max((sd + c.y) / c.y, 0), 1)
    return 1 - t * t * (3 - 2 * t)
  }
  function exclCpu(x, z) {
    let k = 1
    for (const s of exclShapes) {
      const abx = s[2] - s[0], abz = s[3] - s[1], len2 = Math.max(abx * abx + abz * abz, 1e-8)
      let sd
      if (s[6] < 0.5) {
        const t = Math.min(Math.max(((x - s[0]) * abx + (z - s[1]) * abz) / len2, 0), 1)
        sd = Math.hypot(x - s[0] - abx * t, z - s[1] - abz * t) - s[4]
      } else {
        const L = Math.sqrt(len2), ux = abx / L, uz = abz / L, qx = x - (s[0] + abx / 2), qz = z - (s[1] + abz / 2)
        const dx = Math.abs(qx * ux + qz * uz) - L / 2, dz = Math.abs(-qx * uz + qz * ux) - s[4]
        sd = Math.hypot(Math.max(dx, 0), Math.max(dz, 0)) + Math.min(Math.max(dx, dz), 0)
      }
      const t = Math.min(Math.max(sd / s[5], 0), 1)
      k *= t * t * (3 - 2 * t)
    }
    return k
  }

  function set(p = {}) {
    if (p.height !== undefined) params.height = p.height
    if (p.density !== undefined) params.density = p.density
    if (p.radius !== undefined) params.radius = p.radius
    if (p.translucency !== undefined) params.translucency = p.translucency
    if (p.dryness !== undefined) params.dryness = p.dryness
    if (p.colors) params.colors = { ...params.colors, ...p.colors }
    if (p.wind) Object.assign(params.wind, p.wind)
    if (p.exclude) setExclusions(p.exclude)
    if (p.area !== undefined) setArea(p.area)
    if (p.mask !== undefined && typeof p.mask === 'number') U.uMaskCfg.value.y = p.mask
    applyShape(); applyColors(); applyWind()
    prepKey = ''
  }

  setExclusions(o.exclude || [])
  setArea(o.area)
  applyShape(); applyColors(); applyWind()
  update(currentTime)

  return {
    object,
    meshes,
    material,
    uniforms: U, // shader uniforms (advanced tuning; set() covers the documented knobs)
    groundColor, // linear THREE.Color, updated in place by set(): use it for the turf under/beyond the field
    params,
    update,
    set,
    setSun(direction, radiance) { // only used when the scene has no DirectionalLight
      if (direction) U.uSunDir.value.copy(direction).normalize()
      if (radiance) U.uSunRad.value.copy(radiance)
    },
    stats,
    groundAt,
    buildMs: performance.now() - t0,
    dispose() {
      for (const m of meshes) m.geometry.dispose()
      material.dispose()
      for (const t of owned) t.dispose()
    },
  }
}

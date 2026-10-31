// flowers.js: meadow flowers in patches. An eight-species table (petal counts 5/6/8/9 + a variant
// delta, profile pairs, twist table) of parametric petals with analytic normals, painted from a
// 8x5 petal atlas, on crossed-ribbon stems that bend with a per-flower lean, the wind and an
// optional walker. Patches have a dominant species and two companions, a ragged organic edge and
// a dense middle; flowers fade out with distance in the vertex stage.
//
//   import { createFlowers } from './environment/flowers.js'
//   const flowers = await createFlowers({ area: { x: 0, z: 0, radius: 60 }, count: 3000, heightAt, seed: 4 })
//   scene.add(flowers.object)
//   asset.registerAnimation('wind', { name: 'Wind', duration: 60, sample(t) { flowers.update(t) } })
//   // in Play: flowers.setContact(player.position) bends stems away from the feet
//
// species  index 0-7 or name (FLOWER_SPECIES: cream, orange, skyblue, pink, yellow, blue, teal, red),
//          an array of them, or a weighted mix { red: 2, yellow: 1 }; default all eight.
// area     { x, z, radius } | { x, z, width, depth }; patches: number (default count/150) or an array
//          [{ x, z, r, species }]; patchRadius m (11; patches span 0.7-1.5x); count total flowers.
// heightAt(x,z) ground height; mask(x,z) 0..1 (patch centres need >= 0.72, flowers >= 0.42; e.g.
//          terrain.grassAt); maxSlope rise/run (0.42 centres, x1.5 flowers); seed.
// size     flower scale (1 = 0.6-1.1 m stems, 6-12 cm heads); fade [start, end] m ([70, 110]).
// wind 0..1, windDirection rad; update(time s) absolute and deterministic; setContact(v3 | null).
// Texture: '/environment/flower-petals.png' (copy assets/flower-petals.png into public/environment/).
// Cost (measured): ~130-140 tris per flower. One draw per (40 m cell x species present),
//   2 550 flowers in 17 patches = 75 draws, 0.36 M tris, build ~10 ms. No shadow casting by default.
// Ported from Kimi's world-building template (WebGPU/TSL) to WebGL for Edit3D.
import * as THREE from 'three'

const TAU = Math.PI * 2

export const FLOWER_SPECIES = ['cream', 'orange', 'skyblue', 'pink', 'yellow', 'blue', 'teal', 'red']

// ---------------------------------------------------------------------------------------------
// The species table: profile pairs are (radial growth, width, lift power term, lift sine term)
// and (angle variation, bend, twist). Petal counts and the per-variant shape multipliers are what
// make one species read as a daisy and the next as a poppy, so none of it is tuned here.
// ---------------------------------------------------------------------------------------------

const basePetalCount = (s) => (s === 1 || s === 2 || s === 5 || s === 7) ? 5 : s === 3 ? 6 : s === 6 ? 9 : 8
const variantDelta = (v) => v === 0 ? 0 : v === 2 ? 2 : 1

const profileA = (s) =>
  (s === 1 || s === 7) ? [0.35, 0.16, 0.13, 0.055]
    : s === 3 ? [0.42, 0.13, 0.015, 0.04]
      : (s === 2 || s === 5) ? [0.34, 0.15, -0.015, 0.07]
        : s === 6 ? [0.36, 0.09, 0.06, 0.045] : [0.37, 0.105, 0.005, 0.055]

const profileB = (s) =>
  (s === 1 || s === 7) ? [0.075, 0.095, 0.13]
    : s === 3 ? [0.055, 0.085, 0.07]
      : (s === 2 || s === 5) ? [0.085, 0.065, 0.16]
        : s === 6 ? [0.065, 0.10, 0.12] : [0.055, 0.05, 0.09]

const variantShape = (v) =>
  v === 1 ? [0.95, 1.06, 1.18, 0.88]
    : v === 2 ? [1.04, 1.02, 0.72, 1.18]
      : v === 3 ? [0.98, 1.03, 1.24, 1.10]
        : v === 4 ? [0.94, 1.08, 0.86, 0.84] : [1, 1, 1, 1]

const variantTwist = (v) => v === 1 ? 1.28 : v === 2 ? 0.76 : v === 3 ? 1.42 : v === 4 ? 1.16 : 1.0

const speciesCalibration = (s, v) => s !== 5 ? [1, 1]
  : [[1.04, 0.90, 1.14, 0.98, 1.12][v], [0.72, 0.56, 0.64, 0.78, 0.90][v]]

// A point on one petal and its normal from the analytic derivatives of the same surface
// (dP/dalong x dP/dacross): a curling petal lights correctly without a normal map, and without
// the finite-difference error that is worst at the tip where the surface turns hardest.
function petalSurface(species, variant, slot, petalCount, along, across) {
  const a = profileA(species), b = profileB(species)
  const shape = variantShape(variant)
  const cal = speciesCalibration(species, variant)
  const phase = slot * 12.9898 + petalCount * 4.1414 + variant * 7.31
  const variation = Math.sin(phase) * b[0]
  const bendNoise = Math.sin(phase * 1.731 + 0.8)
  const twistNoise = Math.sin(phase * 0.913 - 0.4)
  const twistCoefficient = twistNoise * b[2] * variantTwist(variant)
  const angle = slot / petalCount * TAU + variation * 0.45 + twistCoefficient * Math.pow(along, 1.35)
  const ax = Math.cos(angle), az = Math.sin(angle)
  const tx = -az, tz = ax
  const radialGrowth = a[0] * shape[0] * cal[0] * 0.84 + variation * 0.18
  const radius = 0.004 + along * radialGrowth
  const bend = bendNoise * b[1] * shape[3]
  const liftFloor = -0.032 * Math.pow(along, 1.5)
  const rawLift = a[2] * shape[2] * Math.pow(along, 1.55) + a[3] * shape[3] * Math.sin(Math.PI * along) + bend * Math.pow(along, 1.7)
  const lift = Math.max(liftFloor, rawLift)
  const width = a[1] * shape[1] * cal[1] * 1.32
  const cup = (1 - across * across) * 0.014 * Math.sin(Math.PI * along)
  const position = [ax * radius + tx * across * width, lift + cup, az * radius + tz * across * width]

  const safeAlong = Math.max(along, 0.0001)
  const angleDerivative = twistCoefficient * 1.35 * Math.pow(safeAlong, 0.35)
  const floorDerivative = -0.048 * Math.sqrt(Math.max(along, 0))
  const rawDerivative = a[2] * shape[2] * 1.55 * Math.pow(safeAlong, 0.55)
    + a[3] * shape[3] * Math.PI * Math.cos(Math.PI * along) + bend * 1.7 * Math.pow(safeAlong, 0.7)
  const liftDerivative = rawLift > liftFloor ? rawDerivative : floorDerivative
  const transverseAlong = (1 - across * across) * 0.014 * Math.PI * Math.cos(Math.PI * along)
  const transverseAcross = -2 * across * 0.014 * Math.sin(Math.PI * along)
  const dAlong = [
    ax * (radialGrowth - angleDerivative * across * width) + tx * angleDerivative * radius,
    liftDerivative + transverseAlong,
    az * (radialGrowth - angleDerivative * across * width) + tz * angleDerivative * radius,
  ]
  const dAcross = [tx * width, transverseAcross, tz * width]
  const n = [
    dAcross[1] * dAlong[2] - dAcross[2] * dAlong[1],
    dAcross[2] * dAlong[0] - dAcross[0] * dAlong[2],
    dAcross[0] * dAlong[1] - dAcross[1] * dAlong[0],
  ]
  const nl = Math.hypot(n[0], n[1], n[2]) || 1
  return { position, normal: [n[0] / nl, n[1] / nl, n[2] / nl] }
}

// One flower in head/stem space; nothing is bent here. Stem vertices carry (along, side, plane)
// and get their curve in the vertex stage, because the curve depends on per-flower lean and on
// the wind, and a stem baked bent is a stem that cannot move.
const RADIAL = 4, LATERAL = 2, STEM_SEG = 5

function buildFlower(species, variant) {
  const positions = [], normals = [], uvs = [], parts = [], stems = [], indices = []
  const petalCount = basePetalCount(species) + variantDelta(variant)
  const push = (p, n, u, part, stem) => {
    positions.push(p[0], p[1], p[2]); normals.push(n[0], n[1], n[2]); uvs.push(u[0], u[1])
    parts.push(part); stems.push(stem[0], stem[1], stem[2])
    return positions.length / 3 - 1
  }
  // stem: two ribbons at right angles, from any angle a stem and from no angle a billboard
  for (let plane = 0; plane < 2; plane++) {
    for (let seg = 0; seg < STEM_SEG; seg++) {
      const a0 = seg / STEM_SEG, a1 = (seg + 1) / STEM_SEG
      const base = positions.length / 3
      for (const [along, side] of [[a0, -1], [a0, 1], [a1, -1], [a1, 1]]) push([0, along, 0], [0, 0, 1], [0, along], 0, [along, side, plane])
      indices.push(base, base + 1, base + 2, base + 1, base + 3, base + 2)
    }
  }
  // head: one curved grid per petal
  for (let slot = 0; slot < petalCount; slot++) {
    for (let r = 0; r < RADIAL; r++) {
      for (let l = 0; l < LATERAL; l++) {
        const base = positions.length / 3
        const cells = [[r / RADIAL, l / LATERAL], [(r + 1) / RADIAL, l / LATERAL], [r / RADIAL, (l + 1) / LATERAL], [(r + 1) / RADIAL, (l + 1) / LATERAL]]
        for (const [along, lat] of cells) {
          const across = lat * 2 - 1
          const s = petalSurface(species, variant, slot, petalCount, along, across)
          // the atlas cell is inset so a mip never bleeds the neighbour's colour along a seam
          const localU = 0.03 + (across * 0.5 + 0.5) * 0.94
          const localV = 0.025 + (1 - along) * 0.95
          // only the species *column* is baked; the painted row travels per instance
          push(s.position, s.normal, [(species + localU) / 8, localV], 1, [1, 0, 0])
        }
        indices.push(base, base + 1, base + 2, base + 1, base + 3, base + 2)
      }
    }
  }
  const geometry = new THREE.BufferGeometry()
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3))
  geometry.setAttribute('normal', new THREE.Float32BufferAttribute(normals, 3))
  geometry.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2))
  geometry.setAttribute('aPart', new THREE.Float32BufferAttribute(parts, 1))
  geometry.setAttribute('aStem', new THREE.Float32BufferAttribute(stems, 3))
  geometry.setIndex(indices)
  return { geometry, triangles: indices.length / 3, petalCount }
}

// Two rotated octaves (+1) of value noise; rotating each is what keeps the lattice from showing
// as axis-aligned diamonds when the field is used as a density.
function organic(x, z, frequency, seed) {
  const oct = (fx, fz, rot, w) => {
    const c = Math.cos(rot), s = Math.sin(rot)
    const px = fx * c - fz * s, pz = fx * s + fz * c
    const ix = Math.floor(px), iz = Math.floor(pz)
    const tx = px - ix, tz = pz - iz
    const ux = tx * tx * (3 - 2 * tx), uz = tz * tz * (3 - 2 * tz)
    const h = (a, b) => { const n = Math.sin(a * 127.1 + b * 311.7 + seed) * 43758.5453123; return n - Math.floor(n) }
    return w * ((h(ix, iz) * (1 - ux) + h(ix + 1, iz) * ux) * (1 - uz) + (h(ix, iz + 1) * (1 - ux) + h(ix + 1, iz + 1) * ux) * uz)
  }
  const f = frequency
  return oct(x * f, z * f, 0.0, 0.56) + oct(x * f * 2.07, z * f * 2.07, 0.9, 0.29) + oct(x * f * 2.07 * 1.91, z * f * 2.07 * 1.91, 2.1, 0.15)
}

function lcg(seed) {
  let s = Math.floor(Math.abs(seed)) % 2147483647
  if (s === 0) s = 1
  return () => (s = (s * 48271) % 2147483647) / 2147483647
}

// ---------------------------------------------------------------------------------------------
// Shading: MeshStandardMaterial + onBeforeCompile. The vertex stage rebuilds every vertex from the
// per-flower attributes (stem curve, head frame from the stem's terminal tangent), computing in
// world axes and converting into the object's frame, so the instance transform is kept.
// ---------------------------------------------------------------------------------------------

const VERT_PARS = /* glsl */`
attribute float aPart;
attribute vec3 aStem;      // along, side, plane
attribute vec4 aFlowerA;   // height, lean, curvePower, leanAngle
attribute vec4 aFlowerB;   // phase, headScale, tint, atlas row
uniform float uFloraTime;
uniform vec4 uFloraWind;   // dir (x, z), level
uniform vec3 uContact;
uniform vec2 uFade;
varying float vPart;
varying float vAlong;
varying float vTint;

// Static lean rises as along^curvePower, wind as along^2, so the root never moves; the contact
// bend pushes away from the walker with the same rooted along^2 weight.
vec3 stemPoint( float along, vec3 rootW, float windL ) {
  vec2 leanDir = vec2( cos( aFlowerA.w ), sin( aFlowerA.w ) );
  vec2 staticLean = leanDir * aFlowerA.y * pow( along, aFlowerA.z );
  float signal = sin( uFloraTime * 1.1 + aFlowerB.x ) + sin( uFloraTime * 0.63 + aFlowerB.x * 0.4 ) * 0.32;
  vec2 windOffset = uFloraWind.xy * signal * windL * 0.16 * along * along;
  vec2 delta = rootW.xz - uContact.xz;
  float dist = length( delta );
  vec2 away = delta / max( dist, 0.001 );
  float influence = ( 1.0 - smoothstep( 0.34, 1.35, dist ) ) * along * along;
  return vec3( staticLean.x + windOffset.x + away.x * influence * 0.62,
               aFlowerA.x * along - influence * 0.22,
               staticLean.y + windOffset.y + away.y * influence * 0.62 );
}

void flowerVertex( out vec3 posO, out vec3 nrmO ) {
  mat4 M = modelMatrix;
  #ifdef USE_INSTANCING
    M = M * instanceMatrix;
  #endif
  mat3 R = mat3( M );
  float s2 = dot( R[ 0 ], R[ 0 ] );
  vec3 rootW = M[ 3 ].xyz;
  float L = uFloraWind.z;
  float windL = ( 0.22 + 0.5 * L ) * smoothstep( 0.0, 0.08, L );
  float along = aStem.x;
  vec3 centre = stemPoint( along, rootW, windL );
  float ribbonAngle = aFlowerA.w + aStem.z * 1.5707963;
  vec2 side = vec2( - sin( ribbonAngle ), cos( ribbonAngle ) ) * ( 0.029 * aFlowerB.y * mix( 1.12, 0.44, along ) * aStem.y );
  vec3 stemPos = centre + vec3( side.x, 0.0, side.y );
  // the head looks where the stem points: terminal tangent, a stable per-flower yaw, and the
  // petal surface carried into that frame (only the head scales with the bloom)
  vec3 p0 = stemPoint( 0.92, rootW, windL );
  vec3 p1 = stemPoint( 1.0, rootW, windL );
  vec3 up = normalize( p1 - p0 );
  vec3 seedAxis = vec3( cos( aFlowerB.z * 6.2831853 ), 0.0, sin( aFlowerB.z * 6.2831853 ) );
  vec3 axisX = normalize( seedAxis - up * dot( seedAxis, up ) );
  vec3 axisZ = normalize( cross( up, axisX ) );
  vec3 local = position * aFlowerB.y * 0.50;
  vec3 headPos = p1 + axisX * local.x + up * local.y + axisZ * local.z;
  // far flowers collapse onto their root: no fragments, and the cell LOD then drops the draw
  float fade = smoothstep( uFade.y, uFade.x, distance( rootW, cameraPosition ) );
  vec3 w = mix( stemPos, headPos, aPart ) * fade;
  vec3 n = aPart > 0.5 ? normalize( axisX * normal.x + up * normal.y + axisZ * normal.z ) : vec3( 0.0, 1.0, 0.0 );
  posO = transpose( R ) * w / s2;
  nrmO = transpose( R ) * n;
  vPart = aPart;
  vAlong = along;
  vTint = aFlowerB.z;
}
`

const UV_ROW = /* glsl */`
#include <uv_vertex>
#ifdef USE_MAP
  vMapUv = vec2( uv.x, ( aFlowerB.w + uv.y ) / 5.0 );
#endif
`

const FRAG_PARS = /* glsl */`
uniform float uFloraTrans;
varying float vPart;
varying float vAlong;
varying float vTint;
`

// two-sided diffuse + transmission, added inside three's light loop (directLight.color is shadowed)
const FOLIAGE_LIGHT = /* glsl */`
#include <lights_physical_pars_fragment>
vec3 fTrans = vec3( 0.0 );
float fBack = 0.0;
void RE_Direct_Foliage( const in IncidentLight directLight, const in vec3 geometryPosition, const in vec3 geometryNormal, const in vec3 geometryViewDir, const in vec3 geometryClearcoatNormal, const in PhysicalMaterial material, inout ReflectedLight reflectedLight ) {
  RE_Direct_Physical( directLight, geometryPosition, geometryNormal, geometryViewDir, geometryClearcoatNormal, material, reflectedLight );
  float ndl = dot( geometryNormal, directLight.direction );
  reflectedLight.directDiffuse += max( - ndl, 0.0 ) * fBack * directLight.color * BRDF_Lambert( material.diffuseContribution );
  float back = saturate( dot( - geometryViewDir, directLight.direction ) );
  reflectedLight.directDiffuse += fTrans * directLight.color * ( RECIPROCAL_PI * pow( back, 2.2 ) );
}
#undef RE_Direct
#define RE_Direct RE_Direct_Foliage
`

// stem: a desaturated meadow green paling toward the head; petals: the atlas, a little paler in a
// flower's second week (per-instance tint); stems are opaque whatever the atlas says there
const PETAL_COLOR = /* glsl */`
#include <map_fragment>
{
  vec3 stemCol = mix( vec3( 0.055, 0.135, 0.020 ), vec3( 0.10, 0.20, 0.035 ), smoothstep( 0.0, 0.72, vAlong ) );
  diffuseColor.rgb = mix( stemCol, diffuseColor.rgb, vPart );
  diffuseColor.rgb *= vTint * 0.18 + 0.91;
  diffuseColor.a = mix( 1.0, diffuseColor.a, vPart );
  fTrans = diffuseColor.rgb * ( 0.9 * vPart * uFloraTrans );
  fBack = 0.34;
}
`

function flowerMaterial(map, uniforms) {
  const m = new THREE.MeshStandardMaterial({ name: 'Flowers · Petals & stems', map, roughness: 1, side: THREE.DoubleSide, alphaTest: 0.34 })
  m.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, uniforms)
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\n' + VERT_PARS)
      .replace('#include <uv_vertex>', UV_ROW)
      .replace('#include <beginnormal_vertex>', 'vec3 fPos, fNrm;\nflowerVertex( fPos, fNrm );\nvec3 objectNormal = fNrm;')
      .replace('#include <begin_vertex>', 'vec3 transformed = fPos;')
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', '#include <common>\n' + FRAG_PARS)
      .replace('#include <lights_physical_pars_fragment>', FOLIAGE_LIGHT)
      .replace('#include <map_fragment>', PETAL_COLOR)
      // a stem's up-normal is not flipped for its back face: a ribbon is lit the same from both sides
      .replace('#include <normal_fragment_begin>', '#include <normal_fragment_begin>\nif ( vPart < 0.5 ) normal = normalize( vNormal );')
  }
  m.customProgramCacheKey = () => 'flora-flower'
  return m
}

function flowerDepthMaterial(uniforms) {
  const m = new THREE.MeshDepthMaterial()
  m.name = 'Flowers · shadow'
  m.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, uniforms)
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\n' + VERT_PARS)
      .replace('#include <uv_vertex>', UV_ROW)
      .replace('#include <begin_vertex>', 'vec3 fPos, fNrm;\nflowerVertex( fPos, fNrm );\nvec3 transformed = fPos;')
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', '#include <common>\nvarying float vPart;')
      .replace('#include <map_fragment>', '#include <map_fragment>\ndiffuseColor.a = mix( 1.0, diffuseColor.a, vPart );')
  }
  m.customProgramCacheKey = () => 'flora-flower-depth'
  return m
}

const imageCache = new Map()
async function atlasTexture(url) {
  if (!imageCache.has(url)) imageCache.set(url, new THREE.ImageLoader().loadAsync(url).catch((e) => { imageCache.delete(url); throw e }))
  let image
  try {
    image = await imageCache.get(url)
  } catch {
    console.warn(`flowers.js: petal atlas ${url} not found. Copy src/environment/assets/flower-petals.png to public${url}.`)
    const t = new THREE.DataTexture(new Uint8Array([230, 200, 90, 255]), 1, 1)
    t.colorSpace = THREE.SRGBColorSpace
    t.needsUpdate = true
    return t
  }
  const tex = new THREE.Texture(image)
  tex.colorSpace = THREE.SRGBColorSpace
  tex.anisotropy = 4
  // the atlas is addressed with v = 0 at the *top*; three's default flipY hands every petal its
  // own image upside down, which reads as torn slivers rather than as "flipped"
  tex.flipY = false
  tex.needsUpdate = true
  return tex
}

export function gustLevel(time, wind) {
  const g = 0.5 + 0.32 * Math.sin(time * 0.21 + 1.3 * Math.sin(time * 0.057)) + 0.18 * Math.sin(time * 0.53 + 0.7)
  return wind * (0.62 + 0.38 * Math.min(1, Math.max(0, g)))
}

function resolveSpecies(s) {
  if (typeof s === 'number') return ((Math.floor(s) % 8) + 8) % 8
  const i = FLOWER_SPECIES.indexOf(String(s).toLowerCase())
  if (i < 0) throw new Error(`flowers.js: unknown species "${s}" (0-7 or ${FLOWER_SPECIES.join(' | ')})`)
  return i
}

function weightedPicker(species) {
  let list
  if (species == null) list = FLOWER_SPECIES.map((_, i) => ({ i, w: 1 }))
  else if (Array.isArray(species)) list = species.map((s) => ({ i: resolveSpecies(s), w: 1 }))
  else if (typeof species === 'object') list = Object.entries(species).filter(([, w]) => w > 0).map(([s, w]) => ({ i: resolveSpecies(s), w }))
  else list = [{ i: resolveSpecies(species), w: 1 }]
  const total = list.reduce((a, b) => a + b.w, 0)
  return { list, pick: (r) => { let acc = 0; for (const e of list) { acc += e.w / total; if (r <= acc) return e.i } return list[list.length - 1].i } }
}

// ---------------------------------------------------------------------------------------------
// createFlowers
// ---------------------------------------------------------------------------------------------

const FLOWER_DEFAULTS = {
  species: null, area: { x: 0, z: 0, radius: 50 }, count: 2000, patches: null, patchRadius: 11,
  heightAt: () => 0, mask: null, seed: 60817, maxSlope: 0.42, size: 1, fade: [70, 110],
  cellSize: 40, castShadow: false, receiveShadow: true, wind: 0.35, windDirection: 0.35,
  textureBase: '/environment/',
}

// rebuild(options) re-scatters in place, keeping the Group, the material and the atlas (Edit3D's
// material panel keys materials by scene path; fresh ones would collide and drop user edits).
export async function createFlowers(options = {}) {
  let opts = { ...FLOWER_DEFAULTS, ...options }
  const atlas = await atlasTexture(opts.textureBase + 'flower-petals.png')
  const uniforms = {
    uFloraTime: { value: 0 },
    uFloraWind: { value: new THREE.Vector4(1, 0, opts.wind, 0) },
    uContact: { value: new THREE.Vector3(1e6, 0, 1e6) },
    uFade: { value: new THREE.Vector2(opts.fade[0], opts.fade[1]) },
    uFloraTrans: { value: 1 },
  }
  const state = { time: 0, wind: opts.wind, dir: opts.windDirection }
  const applyWind = () => {
    uniforms.uFloraWind.value.set(Math.cos(state.dir), Math.sin(state.dir), gustLevel(state.time, state.wind), 0)
    uniforms.uFloraTime.value = state.time
  }
  applyWind()
  const material = flowerMaterial(atlas, uniforms)
  const depth = flowerDepthMaterial(uniforms)
  // one geometry per species (variant 1, the middle of the five shapes, stands for all of them;
  // the painted row still varies per flower, so eight geometries carry forty petal images)
  const kinds = []
  for (let s = 0; s < 8; s++) kinds.push(buildFlower(s, 1))
  const object = new THREE.Group()
  object.name = 'Flowers'
  let geometries = [], stats = null, centres = [], count = 0

  function build() {
    const t0 = performance.now()
    const { area, patchRadius, heightAt, mask, seed, maxSlope, size, fade, cellSize } = opts
    const rnd = lcg(seed)
    const picker = weightedPicker(opts.species)
    uniforms.uFade.value.set(fade[0], fade[1])
    const slopeAt = (x, z) => {
      const d = 1.5
      return Math.hypot(heightAt(x + d, z) - heightAt(x - d, z), heightAt(x, z + d) - heightAt(x, z - d)) / (2 * d)
    }

    // ---- patch centres: open, gentle ground the mask likes, spaced apart
    const cx = area.x ?? area.center?.[0] ?? 0, cz = area.z ?? area.center?.[1] ?? 0
    const sample = area.radius != null
      ? () => { const a = rnd() * TAU, d = Math.sqrt(rnd()) * area.radius; return [cx + Math.cos(a) * d, cz + Math.sin(a) * d] }
      : () => [cx + (rnd() - 0.5) * (area.width ?? area.size ?? 100), cz + (rnd() - 0.5) * (area.depth ?? area.size ?? area.width ?? 100)]
    const companions = (dominant) => {
      if (picker.list.length >= 3) {
        let a = picker.pick(rnd()), b = picker.pick(rnd()), guard = 0
        while ((a === dominant || b === dominant || a === b) && guard++ < 20) { a = picker.pick(rnd()); b = picker.pick(rnd()) }
        return [dominant, a, b]
      }
      if (picker.list.length === 2) { const o = picker.list.find((e) => e.i !== dominant)?.i ?? dominant; return [dominant, o, o] }
      return [dominant, dominant, dominant]
    }
    centres = []
    if (Array.isArray(opts.patches)) {
      centres = opts.patches.map((p) => {
        const dom = p.species != null ? resolveSpecies(p.species) : picker.pick(rnd())
        return { x: p.x, z: p.z, r: p.r ?? patchRadius, mix: p.mix ? p.mix.map(resolveSpecies) : companions(dom) }
      })
    } else {
      const n = Math.max(1, opts.patches ?? Math.round(opts.count / 150))
      for (let pass = 0; pass < 3 && centres.length < n; pass++) {
        const minGap = patchRadius * [3.2, 2.0, 1.2][pass]
        for (let attempt = 0; attempt < n * 400 && centres.length < n; attempt++) {
          const [x, z] = sample()
          if (mask && mask(x, z) < 0.72) continue
          if (slopeAt(x, z) > maxSlope) continue
          if (centres.some((c) => (c.x - x) ** 2 + (c.z - z) ** 2 < minGap * minGap)) continue
          // one patch, one dominant species with two companions through it: a real stand of one
          // flower is a stand of one flower, and the minority keeps the edge honest
          centres.push({ x, z, r: patchRadius * (0.7 + rnd() * 0.8), mix: companions(picker.pick(rnd())) })
        }
      }
    }

    // ---- scatter: organic keep field (ragged edge, dense middle) x cubic falloff
    const perPatch = Math.ceil(opts.count / Math.max(1, centres.length))
    const items = []
    for (const patch of centres) {
      let kept = 0
      for (let i = 0; i < perPatch * 8 && kept < perPatch; i++) {
        const a = rnd() * TAU, d = Math.sqrt(rnd()) * patch.r
        const x = patch.x + Math.cos(a) * d, z = patch.z + Math.sin(a) * d
        const broad = organic(x, z, 0.024, 307 + seed % 101)
        const detail = organic(x, z, 0.071, 401 + seed % 103)
        const t = Math.min(1, Math.max(0, (broad * 0.78 + detail * 0.22 - 0.31) / (0.73 - 0.31)))
        const keep = 0.10 + 0.82 * (t * t * (3 - 2 * t))
        const falloff = 1 - (d / patch.r) ** 3
        if (rnd() > keep * falloff) continue
        if (mask && mask(x, z) < 0.42) continue
        if (slopeAt(x, z) > maxSlope * 1.5) continue
        const h = heightAt(x, z)
        const roll = rnd()
        const sp = patch.mix[roll < 0.70 ? 0 : roll < 0.87 ? 1 : 2]
        const painted = Math.floor(rnd() * 5)
        const vigor = 0.68 + rnd() * 0.32
        const scale = (0.72 + rnd() * 0.56) * size
        const height = (1.12 + (vigor - 0.68) / 0.32 * 0.36) * scale * 0.78
        const lean = (0.12 + Math.pow(rnd(), 0.72) * 0.50) * (0.72 + vigor * 0.33) * scale * 0.5
        const curvePower = 1.72 + rnd() * 0.76
        const leanAngle = rnd() * TAU
        items.push({ sp, x, y: h, z, a: [height, lean, curvePower, leanAngle], b: [rnd() * TAU, scale * 0.86, rnd(), painted] })
        kept++
      }
    }

    // ---- meshes: one InstancedMesh per (cell, species); each cell is a THREE.LOD whose far level
    // is empty, so a cell beyond the fade distance costs no draw (the vertex fade already hid it)
    for (const child of [...object.children]) object.remove(child)
    for (const g of geometries) g.dispose()
    geometries = []
    const cells = new Map()
    for (const f of items) {
      const key = `${Math.floor(f.x / cellSize)},${Math.floor(f.z / cellSize)}`
      if (!cells.has(key)) cells.set(key, [])
      cells.get(key).push(f)
    }
    let triangles = 0, draws = 0
    const _m = new THREE.Matrix4()
    for (const list of cells.values()) {
      let mx = 0, mz = 0, my = 0
      for (const f of list) { mx += f.x; my += f.y; mz += f.z }
      mx /= list.length; my /= list.length; mz /= list.length
      let rad = 0
      for (const f of list) rad = Math.max(rad, Math.hypot(f.x - mx, f.z - mz))
      const lod = new THREE.LOD()
      lod.name = 'Flower cell'
      lod.position.set(mx, my, mz)
      const near = new THREE.Group()
      near.name = 'Flower cell · near'
      const bySpecies = new Map()
      for (const f of list) { if (!bySpecies.has(f.sp)) bySpecies.set(f.sp, []); bySpecies.get(f.sp).push(f) }
      for (const [sp, fl] of bySpecies) {
        const kind = kinds[sp]
        const geometry = new THREE.BufferGeometry()
        for (const name of ['position', 'normal', 'uv', 'aPart', 'aStem']) geometry.setAttribute(name, kind.geometry.getAttribute(name))
        geometry.setIndex(kind.geometry.index)
        const A = new Float32Array(fl.length * 4), Bv = new Float32Array(fl.length * 4)
        fl.forEach((f, i) => { A.set(f.a, i * 4); Bv.set(f.b, i * 4) })
        geometry.setAttribute('aFlowerA', new THREE.InstancedBufferAttribute(A, 4))
        geometry.setAttribute('aFlowerB', new THREE.InstancedBufferAttribute(Bv, 4))
        const mesh = new THREE.InstancedMesh(geometry, material, fl.length)
        mesh.name = `Flowers · ${FLOWER_SPECIES[sp]}`
        fl.forEach((f, i) => mesh.setMatrixAt(i, _m.makeTranslation(f.x - mx, f.y - my, f.z - mz)))
        mesh.instanceMatrix.needsUpdate = true
        mesh.computeBoundingSphere()
        mesh.boundingSphere.radius += 1.6 * size // the baked bounds know nothing of the stem it grows
        mesh.castShadow = opts.castShadow
        mesh.receiveShadow = opts.receiveShadow
        mesh.customDepthMaterial = depth
        near.add(mesh)
        geometries.push(geometry)
        triangles += kind.triangles * fl.length
        draws++
      }
      lod.addLevel(near, 0)
      lod.addLevel(new THREE.Object3D(), fade[1] + rad + 2)
      object.add(lod)
    }
    count = items.length
    stats = { flowers: items.length, patches: centres.length, triangles, draws, trianglesPerFlower: Math.round(triangles / Math.max(1, items.length)), buildMs: +(performance.now() - t0).toFixed(1) }
  }
  build()

  return {
    object, material,
    get count() { return count },
    get patches() { return centres.map((c) => ({ x: c.x, z: c.z, r: c.r, species: c.mix.map((i) => FLOWER_SPECIES[i]) })) },
    get stats() { return stats },
    get options() { return { ...opts } },
    update(time) { if (time === state.time) return; state.time = time; applyWind() },
    setWind(w, direction = state.dir) { state.wind = w; state.dir = direction; applyWind() },
    setContact(p) { if (p) uniforms.uContact.value.set(p.x, p.y ?? 0, p.z); else uniforms.uContact.value.set(1e6, 0, 1e6) },
    rebuild(o = {}) {
      opts = { ...opts, ...o }
      if ('wind' in o || 'windDirection' in o) { state.wind = opts.wind; state.dir = opts.windDirection; applyWind() }
      build()
    },
    dispose() {
      for (const g of geometries) g.dispose()
      for (const k of kinds) k.geometry.dispose()
      material.dispose(); depth.dispose(); atlas.dispose()
    },
  }
}

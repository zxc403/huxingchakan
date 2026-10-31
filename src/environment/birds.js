// birds.js — a flock of procedural herring gulls wheeling overhead: one merged geometry, ONE draw,
// flown entirely in the vertex stage from per-vertex attributes (which circle, how fast, where on the
// wing this vertex sits). Gulls glide most of the time and beat in bursts, the wing is a travelling
// wave (tip lags the shoulder) with a pitch twist, and they bank into their turns.
//
//   import { createBirds } from './environment/birds.js'
//   const gulls = createBirds({ count: 24, area: { center: [0, 0], radius: 80 }, height: [8, 30], heightAt })
//   scene.add(gulls.object)
//   asset.registerAnimation('gulls', { objectId: 'gulls', duration: 60, sample: (t) => gulls.update(t) })
//
// Parameters: count (birds, 8–80; default 24) · area { center:[x,z], radius m } where the circles are
// centred (default 80 m around the origin) · height [min,max] metres above ground (default [8, 30]) ·
// groups (shared circles, default 4) · heightAt(x,z) for ground clearance · view { eye:[x,y,z],
// target:[x,y,z] } flies two groups into that shot (a 1.4 m gull at 90 m is ~7 px, so placement is
// measured from the lens) · size (1 = true herring-gull wingspan 1.24–1.56 m) · seed.
// Lighting: MeshLambertMaterial (scene sun, environment/hemisphere, fog, tone mapping) + light through
// the spread primaries when backlit. update(time) is absolute and deterministic.
// Cost: 1 draw, 124 triangles / 88 vertices per bird (24 birds ≈ 3k tris), update ~0 ms (one uniform).
// Ported from Kimi's world-building template (WebGPU/TSL) to WebGL for Edit3D.
import * as THREE from 'three'

const SPAN_STATIONS = 7

// local frame: +x right wing, +y up, +z forward; span runs to ±1 (scale 0.62 = 1.24 m wingspan)
function appendGull(g, out) {
  const { positions, normals, shapes, orbits, flights, drifts, indices } = out
  const vert = (px, py, pz, nx, ny, nz, side, span, part) => {
    positions.push(px, py, pz); normals.push(nx, ny, nz); shapes.push(side, span, part)
    orbits.push(g.cx, g.cz, g.radius, g.alt); flights.push(g.omega, g.phase, g.flapOff, g.scale)
    drifts.push(g.driftR, g.driftW, g.driftP, g.bob)
    return positions.length / 3 - 1
  }
  // body: a spindle, head forward, tail root aft
  const RINGS = [[-0.34, 0.010], [-0.26, 0.038], [-0.14, 0.064], [-0.02, 0.074], [0.09, 0.068], [0.18, 0.050], [0.25, 0.038], [0.32, 0.012]]
  const SIDES = 7
  const ringStart = []
  for (const [z, r] of RINGS) {
    ringStart.push(positions.length / 3)
    for (let s = 0; s < SIDES; s++) {
      const a = (s / SIDES) * Math.PI * 2, cx = Math.cos(a), sy = Math.sin(a)
      vert(cx * r * 1.15, sy * r * 0.86 - 0.012, z, cx, sy, 0, 0, 0, 0)
    }
  }
  for (let i = 0; i < RINGS.length - 1; i++) {
    const a = ringStart[i], b = ringStart[i + 1]
    for (let s = 0; s < SIDES; s++) {
      const s2 = (s + 1) % SIDES
      indices.push(a + s, b + s, a + s2, a + s2, b + s, b + s2)
    }
  }
  // wings: a quad strip per side, swept and tapered to a point
  for (const side of [-1, 1]) {
    const le = [], te = []
    for (let i = 0; i < SPAN_STATIONS; i++) {
      const t = i / (SPAN_STATIONS - 1)
      const x = side * (0.055 + 0.945 * Math.pow(t, 0.98))
      const leZ = 0.115 - 0.30 * Math.pow(t, 1.35)
      const chord = 0.245 * (1 - 0.80 * Math.pow(t, 1.25))
      const y = 0.026 * (1 - t)
      le.push(vert(x, y, leZ, 0, 1, 0, side, t, 1))
      te.push(vert(x, y, leZ - chord, 0, 1, 0, side, t, 1))
    }
    for (let i = 0; i < SPAN_STATIONS - 1; i++) {
      if (side > 0) indices.push(le[i], te[i], le[i + 1], le[i + 1], te[i], te[i + 1])
      else indices.push(le[i], le[i + 1], te[i], te[i], le[i + 1], te[i + 1])
    }
  }
  // tail: a short fan behind the body
  const tRoot = vert(0, -0.006, -0.28, 0, 1, 0, 0, 0, 2), tL = vert(-0.085, -0.006, -0.53, 0, 1, 0, 0, 0, 2)
  const tR = vert(0.085, -0.006, -0.53, 0, 1, 0, 0, 0, 2), tM = vert(0, -0.006, -0.56, 0, 1, 0, 0, 0, 2)
  indices.push(tRoot, tL, tM, tRoot, tM, tR)
}

const VERT_PARS = /* glsl */ `
uniform float uTime;
attribute vec3 aShape;
attribute vec4 aOrbit;
attribute vec4 aFlight;
attribute vec4 aDrift;
varying vec3 vShape;
`
// the whole flight from one clock: a circle whose centre itself drifts (two incommensurate rates, so the
// path never closes), nose following the tangent and the bob's climb, banked toward the centre
const VERT_MAIN = /* glsl */ `
float gSide = aShape.x; float gSpan = aShape.y;
float omega = aFlight.x; float phase = aFlight.y; float flapOff = aFlight.z; float gScale = aFlight.w;
float T = uTime;
float ocx = aOrbit.x + aDrift.x * cos( aDrift.y * T + aDrift.z );
float ocz = aOrbit.y + aDrift.x * sin( aDrift.y * T * 0.83 + aDrift.z * 1.7 );
float R = aOrbit.z * ( sin( T * 0.11 + phase ) * 0.18 + 1.0 );
float ang = phase + omega * T;
float ca = cos( ang ); float sa = sin( ang );
float bobPh = T * 0.37 + phase * 2.1;
float alt = aOrbit.w + aDrift.w * sin( bobPh ) + sin( T * 0.13 + phase ) * 0.6;
vec3 centre = vec3( ocx + R * ca, alt, ocz + R * sa );
float sgn = clamp( omega * 1e4, - 1.0, 1.0 );
float climb = aDrift.w * 0.37 * cos( bobPh ) / max( abs( omega ) * R, 0.5 );
vec3 fwd = normalize( vec3( - sa * sgn, climb, ca * sgn ) );
vec3 right0 = normalize( cross( vec3( 0.0, 1.0, 0.0 ), fwd ) );
vec3 up0 = cross( fwd, right0 );
float bank = sgn * ( sin( T * 0.29 + phase ) * 0.13 + 0.40 );
float cb = cos( bank ); float sb = sin( bank );
vec3 bRight = right0 * cb + up0 * sb;
vec3 bUp = up0 * cb - right0 * sb;
// bursts of beating between long glides; inside a burst a travelling wave down the span
float burst = smoothstep( 0.52, 0.86, sin( T * 0.21 + flapOff * 6.3 ) * 0.5 + 0.5 );
float beat = T * 17.0 + flapOff * 11.0 - gSpan * 1.5;
float flapA = ( 0.13 - gSpan * gSpan * 0.30 + burst * 0.62 * sin( beat ) ) * gSide;
float twistA = - burst * 0.34 * cos( beat ) * gSpan;
float cw = cos( twistA ); float sw = sin( twistA ); float cf = cos( flapA ); float sf = sin( flapA );
mat3 gDeform = mat3( cf, sf, 0.0, - sf, cf, 0.0, 0.0, 0.0, 1.0 ) * mat3( 1.0, 0.0, 0.0, 0.0, cw, sw, 0.0, - sw, cw );
mat3 gToWorld = mat3( bRight, bUp, fwd );
vec3 objectNormal = normalize( gToWorld * ( gDeform * normal ) );
vec3 gPos = centre + gToWorld * ( gDeform * position ) * gScale;
vShape = aShape;
`

const FRAG_PARS = /* glsl */ `
varying vec3 vShape;
`
const FRAG_COLOR = /* glsl */ `
{
  // herring gull: white body and tail, pale grey mantle over the inner wing, black outer primaries
  vec3 white = vec3( 0.83, 0.83, 0.79 );
  vec3 mantle = vec3( 0.30, 0.34, 0.39 );
  vec3 tipC = vec3( 0.010, 0.010, 0.012 );
  vec3 wing = mix( white, mantle, smoothstep( 0.10, 0.55, vShape.y ) );
  wing = mix( wing, tipC, smoothstep( 0.76, 0.90, vShape.y ) );
  float isWing = smoothstep( 0.5, 1.0, vShape.z ) * smoothstep( 1.5, 1.2, vShape.z );
  diffuseColor.rgb *= mix( white, wing, isWing );
}
`
// thin spread primaries let the sun through when backlit: the gull flares rather than silhouettes
const FRAG_THROUGH = /* glsl */ `
#if NUM_DIR_LIGHTS > 0
{
  float isWingT = smoothstep( 0.5, 1.0, vShape.z ) * smoothstep( 1.5, 1.2, vShape.z );
  float through = pow( saturate( dot( - geometryViewDir, directionalLights[ 0 ].direction ) ), 4.0 ) * isWingT * 0.7;
  reflectedLight.directDiffuse += material.diffuseColor * directionalLights[ 0 ].color * ( through * RECIPROCAL_PI );
}
#endif
`

export function createBirds(options = {}) {
  const t0 = performance.now()
  const o = { count: 24, groups: 4, height: [8, 30], seed: 1, size: 1, area: { center: [0, 0], radius: 80 }, ...options }
  const [ax, az] = o.area.center || [0, 0]
  const areaR = o.area.radius ?? 80
  const ground = (x, z) => (o.heightAt ? o.heightAt(x, z) : (o.groundY ?? 0))
  let seed = (Math.abs(Math.floor(o.seed)) * 48271 + 20260818) % 2147483647 || 1
  const rand = () => (seed = (seed * 48271) % 2147483647) / 2147483647
  const rng = (a, b) => a + rand() * (b - a)

  // group centres: optionally two flown into a given shot, the rest spread over the area
  const centres = []
  if (o.view) {
    const [ex, , ez] = o.view.eye, [tx, , tz] = o.view.target
    const view = Math.atan2(tz - ez, tx - ex)
    for (const [r0, r1] of [[20, 42], [70, 140]]) {
      const a = view + rng(-0.96, 0.96), r = rng(r0, r1)
      centres.push({ x: ex + Math.cos(a) * r, z: ez + Math.sin(a) * r, home: true })
    }
  }
  const wanted = Math.max(1, Math.round(o.groups))
  const sep = Math.max(areaR * 0.5, 10)
  for (let guard = 0; guard < 4000 && centres.length < wanted + (o.view ? 2 : 0); guard++) {
    const a = rand() * Math.PI * 2, r = Math.sqrt(rand()) * areaR
    const x = ax + Math.cos(a) * r, z = az + Math.sin(a) * r
    if (guard < 3000 && centres.some((c) => (c.x - x) ** 2 + (c.z - z) ** 2 < sep * sep)) continue
    centres.push({ x, z, home: false })
  }
  // gulls wheel in loose company: the on-camera groups take a double share
  const bag = []
  centres.forEach((c, i) => bag.push(i, ...(c.home ? [i] : [])))

  const out = { positions: [], normals: [], shapes: [], orbits: [], flights: [], drifts: [], indices: [] }
  const maxR = Math.max(8, areaR * 0.7)
  for (let i = 0; i < o.count; i++) {
    const c = centres[bag[i % bag.length]]
    const sgn = rand() < 0.5 ? -1 : 1
    const radius = c.home ? rng(8, 19) : rng(Math.min(16, maxR * 0.4), Math.min(62, maxR))
    const speed = rng(8.5, 13.0) // m/s — a gull cruises about 11
    const jit = c.home ? 10 : Math.min(26, areaR * 0.3)
    const cx = c.x + rng(-jit, jit), cz = c.z + rng(-jit, jit)
    appendGull({
      cx, cz, radius,
      alt: ground(cx, cz) + rng(o.height[0], o.height[1]),
      omega: (sgn * speed) / radius,
      phase: rng(0, Math.PI * 2),
      flapOff: rng(0, 1),
      scale: rng(0.62, 0.78) * o.size,
      driftR: rng(8, 34) * Math.min(1, areaR / 80),
      driftW: rng(0.02, 0.055) * (rand() < 0.5 ? -1 : 1),
      driftP: rng(0, Math.PI * 2),
      bob: rng(0.8, 3.4),
    }, out)
  }

  const geometry = new THREE.BufferGeometry()
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(out.positions, 3))
  geometry.setAttribute('normal', new THREE.Float32BufferAttribute(out.normals, 3))
  geometry.setAttribute('aShape', new THREE.Float32BufferAttribute(out.shapes, 3))
  geometry.setAttribute('aOrbit', new THREE.Float32BufferAttribute(out.orbits, 4))
  geometry.setAttribute('aFlight', new THREE.Float32BufferAttribute(out.flights, 4))
  geometry.setAttribute('aDrift', new THREE.Float32BufferAttribute(out.drifts, 4))
  geometry.setIndex(out.indices)
  geometry.boundingSphere = new THREE.Sphere(new THREE.Vector3(ax, 0, az), 0)
  geometry.boundingBox = new THREE.Box3() // flown in the vertex stage: keep it out of editor framing

  const uTime = { value: o.time ?? 6 }
  const material = new THREE.MeshLambertMaterial({ name: 'Gull', side: THREE.DoubleSide })
  material.onBeforeCompile = (shader) => {
    shader.uniforms.uTime = uTime
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\n' + VERT_PARS)
      .replace('#include <beginnormal_vertex>', VERT_MAIN)
      .replace('#include <begin_vertex>', 'vec3 transformed = gPos;')
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', '#include <common>\n' + FRAG_PARS)
      .replace('#include <color_fragment>', '#include <color_fragment>\n' + FRAG_COLOR)
      .replace('#include <lights_fragment_end>', FRAG_THROUGH + '#include <lights_fragment_end>')
  }
  material.customProgramCacheKey = () => 'edit3d-gulls-v1'

  const mesh = new THREE.Mesh(geometry, material)
  mesh.name = 'Gulls'
  mesh.frustumCulled = false // every gull moves in the vertex stage
  mesh.raycast = () => {}
  mesh.castShadow = false

  return {
    object: mesh,
    mesh,
    material,
    count: o.count,
    triangles: out.indices.length / 3,
    buildMs: performance.now() - t0,
    update(time) { uTime.value = time },
    dispose() { geometry.dispose(); material.dispose() },
  }
}

// trees.js: procedural trees grown from species tables. A structured ash (four branch orders,
// photographed compound-leaf cards) and a coconut palm (pinnate fronds of single leaflets),
// as ONE editable hero tree or as a wood of hundreds (one draw per species and part, per-tree
// frustum culling, near/far LOD). Wind sways crowns and flutters leaves in the vertex stage,
// leaves glow when the sun is behind them, and shadows/fog/env light/log depth all work.
//
//   import { createTree, createForest } from './environment/trees.js'
//   const ash = await createTree({ species: 'ash', height: 16 })      // hero, editable as one object
//   ash.object.position.set(0, heightAt(0, 0), 0); scene.add(ash.object)
//   const wood = await createForest({ species: { ash: 0.8, palm: 0.2 }, area: { x: 0, z: -80, radius: 70 },
//     count: 120, heightAt, mask: (x, z) => terrain.treeAt(x, z), seed: 7 }); scene.add(wood.object)
//   asset.registerAnimation('wind', { name: 'Wind', duration: 60, sample(t) { ash.update(t); wood.update(t) } })
//
// species  'ash' (16-20 m broadleaf, the template's contract table) | 'palm' (8-14 m coconut palm);
//          createForest also takes a mix { ash: 0.7, palm: 0.3 }. TREE_SPECIES lists them.
// createTree  { species, seed (ash default 36330 = the contract specimen; palm 4242), height m
//          (ash 12-20, palm 7-14), lean rad 0-0.25, tint 0..1 (olive -> yellow-green), lod 0|1 }
// createForest  { area {x,z,radius} | {x,z,width,depth}, or points [[x,z]|{x,z}], count, heightAt(x,z),
//          mask(x,z) 0..1, seed, spacing m (7.5; packs to ~4.5 in stands, opens to ~11), clustering
//          0..1 (stands + clearings), maxSlope rise/run (0.72), lodDistance m (55), castShadow }
// both     wind 0..1 (0.35 breeze, 1 gale), windDirection rad (0 = +X), update(time s) (absolute,
//          deterministic), setWind(wind, direction), dispose(). Textures load from textureBase
//          ('/environment/': copy assets/ash-leaf.png there; palms need no texture).
// Lighting: one DirectionalLight (+ hemisphere or scene.environment). For leaf self-shadowing use
//          sun.shadow.normalBias ~0.04-0.08. Material.color on each card tints that part.
// Cost (measured, M-series): ash 20.0k tris near / 5.9k far, palm 3.5k / 1.4k. A hero tree is 2 draws
//          (+2 shadow), build ~30 ms. A wood is 2 draws per species (+2 shadow) whatever its size:
//          100 ash = 2.0 M tris all-near / 0.59 M all-far (LOD at 55 m), build ~90 ms; 11 palms 17 ms.
//          update(): ~1 us (uniforms only); LOD/culling runs per pass inside onBeforeRender.
// Ported from Kimi's world-building template (WebGPU/TSL) to WebGL for Edit3D.
import * as THREE from 'three'

const TAU = Math.PI * 2
const srgb = (r, g, b) => new THREE.Color().setRGB(r, g, b, THREE.SRGBColorSpace)

// ---------------------------------------------------------------------------------------------
// Randomness: the tree generator's own two-register RNG (kept so the contract seeds grow the
// same trees), and the Lehmer LCG the palms and the scatter use.
// ---------------------------------------------------------------------------------------------

class SeededRandom {
  constructor(seed) {
    this.w = (123456789 + seed) | 0
    this.z = (987654321 - seed) | 0
  }
  value(max = 1, min = 0) {
    this.z = (36969 * (this.z & 65535) + (this.z >> 16)) | 0
    this.w = (18000 * (this.w & 65535) + (this.w >> 16)) | 0
    const normalized = (((this.z << 16) + (this.w & 65535)) >>> 0) / 4294967296
    return min + (max - min) * normalized
  }
  shuffledIndices(count) {
    const values = Array.from({ length: count }, (_, index) => index)
    for (let index = count - 1; index > 0; index -= 1) {
      const swap = Math.floor(this.value() * (index + 1))
      ;[values[index], values[swap]] = [values[swap], values[index]]
    }
    return values
  }
}

function lcg(seed) {
  let s = Math.floor(Math.abs(seed)) % 2147483647
  if (s === 0) s = 1
  return () => (s = (s * 48271) % 2147483647) / 2147483647
}

// ---------------------------------------------------------------------------------------------
// Species. The ash table is a contract: the uneven angles, the per-level child counts and the
// 0.23/0.33 emergence starts are what make the silhouette an ash rather than a generic fractal.
// ---------------------------------------------------------------------------------------------

const ASH_MEDIUM = {
  seed: 36330,
  branchLevels: 3,
  branch: {
    angle: [0, 48, 75, 60],
    children: [7, 4, 3, 0],
    forceDirection: [0, 1, 0],
    forceStrength: 0.01,
    gnarliness: [0.03, 0.25, 0.2, 0.09],
    length: [43.47, 27.14, 9.51, 4.6],
    radius: [2, 0.63, 0.76, 0.7],
    sections: [12, 8, 6, 4],
    segments: [12, 6, 4, 3],
    start: [0, 0.23, 0.33, 0],
    taper: [0.7, 0.7, 0.7, 0.7],
    twist: [0.09, -0.07, 0, 0],
  },
  leaves: { angle: 55, count: 16, start: 0, size: 2.67, sizeVariance: 0.72, alphaTest: 0.5 },
}

export const TREE_SPECIES = {
  ash: {
    kind: 'system',
    label: 'Ash',
    preset: ASH_MEDIUM,
    // five trees, not one repeated: the table stays fixed and the seed walks a different path
    // through it; heights spread the way a stand does (a couple of emergents, mostly mid-storey)
    variants: [
      { seed: 36330, height: 19.5 }, { seed: 51207, height: 16.0 }, { seed: 8891, height: 14.2 },
      { seed: 74413, height: 17.8 }, { seed: 22056, height: 12.6 },
    ],
    defaultHeight: 16,
    scale: [0.82, 1.12],       // per-tree scale on top of the variant height
    lean: 0.055,               // max random lean (rad)
    sink: 0.25,                // root sunk this far (m x scale) so a slope does not show a heel
    leafTexture: 'ash-leaf.png',
    bark: { dark: srgb(0.155, 0.148, 0.134), light: srgb(0.575, 0.558, 0.512) },
  },
  palm: {
    kind: 'palm',
    label: 'Palm',
    variants: [{ seed: 4242 }, { seed: 917 }, { seed: 27183 }, { seed: 31337 }],
    defaultHeight: 10,
    scale: [0.85, 1.5],
    lean: 0.17,
    sink: 0.15,
  },
}

// ---------------------------------------------------------------------------------------------
// Structured growth (the ash). Orientation slerps from B *toward* A: that reversed interpolation
// is what sets the characteristic roll of an emerging branch. Kept.
// ---------------------------------------------------------------------------------------------

function interpolateSection(sections, normalizedDistance) {
  const scaled = normalizedDistance * (sections.length - 1)
  const indexA = Math.min(Math.floor(scaled), sections.length - 1)
  const indexB = Math.min(indexA + 1, sections.length - 1)
  const alpha = scaled - indexA
  const sectionA = sections[indexA]
  const sectionB = sections[indexB]
  const qA = new THREE.Quaternion().setFromEuler(sectionA.orientation)
  const qB = new THREE.Quaternion().setFromEuler(sectionB.orientation)
  return {
    origin: new THREE.Vector3().lerpVectors(sectionA.origin, sectionB.origin, alpha),
    radius: THREE.MathUtils.lerp(sectionA.radius, sectionB.radius, alpha),
    orientation: new THREE.Euler().setFromQuaternion(qB.slerp(qA, alpha)),
  }
}

const _Y = new THREE.Vector3(0, 1, 0)
const _X = new THREE.Vector3(1, 0, 0)

// Grows one tree in local space (root at origin, +Y up, exactly `height` m tall) and returns two
// geometries: bark (position, normal, aWind=(sway, 0), aSurf=(m along limb, m around limb)) and
// leaves (+uv, aWind=(sway, flutter), aSurf=(per-leaf random, outwardness in the crown)).
// lod 1 keeps the same skeleton and silhouette (the RNG walks the same path) but drops the
// finest twigs, halves the radial segments and keeps one leaf card in three at 1.7x the size.
function growSystemTree(preset, { height = 16, lod = 0 } = {}) {
  const random = new SeededRandom(preset.seed)
  const forceDirection = new THREE.Vector3(...preset.branch.forceDirection).normalize()
  const far = lod > 0
  const keep = far ? 3 : 1
  const grow = Math.sqrt(keep)

  const B = { p: [], n: [], raw: [], s: [], i: [] }           // bark
  const L = { p: [], n: [], uv: [], raw: [], fl: [], s: [], i: [] } // leaves
  const leafOrigins = [], leafStart = []
  let leafSerial = 0, maxY = 0

  const jobs = [{
    origin: new THREE.Vector3(), orientation: new THREE.Euler(),
    length: preset.branch.length[0], radius: preset.branch.radius[0], level: 0,
    sectionCount: preset.branch.sections[0], segmentCount: preset.branch.segments[0],
  }]

  const corners = [new THREE.Vector3(), new THREE.Vector3(), new THREE.Vector3(), new THREE.Vector3()]
  const UVS = [[0, 1], [0, 0], [1, 0], [1, 1]]

  function emitLeaf(origin, orientation) {
    const size = preset.leaves.size * (1 + random.value(preset.leaves.sizeVariance, -preset.leaves.sizeVariance))
    const rand = random.value()
    leafOrigins.push(origin.clone())
    const kept = (leafSerial++ % keep) === 0
    const cardNormal = new THREE.Vector3(0, 0, 1).applyEuler(orientation).normalize()
    const card = (s, cardRotation) => {
      corners[0].set(-s * 0.5, s, 0); corners[1].set(-s * 0.5, 0, 0)
      corners[2].set(s * 0.5, 0, 0); corners[3].set(s * 0.5, s, 0)
      for (const c of corners) c.applyAxisAngle(_Y, cardRotation).applyEuler(orientation).add(origin)
      return corners
    }
    // the unthinned silhouette sets the scale, so both LODs come out the same height
    for (const rot of [0, Math.PI * 0.5]) for (const v of card(size, rot)) if (v.y > maxY) maxY = v.y
    if (!kept) { leafStart.push(-1); return }
    leafStart.push(L.p.length / 3)
    for (const rot of [0, Math.PI * 0.5]) {
      const base = L.p.length / 3
      card(size * grow, rot).forEach((v, k) => {
        // Both perpendicular cards use the *unrotated* card normal plus the vertex direction:
        // a quirk of the contract that keeps a leaf pair from lighting as two separate flags.
        const nrm = cardNormal.clone().add(v.clone().sub(origin)).normalize()
        L.p.push(v.x, v.y, v.z); L.n.push(nrm.x, nrm.y, nrm.z); L.uv.push(UVS[k][0], UVS[k][1])
        L.raw.push(v.y, preset.branchLevels); L.fl.push(UVS[k][1]); L.s.push(rand, 0)
      })
      L.i.push(base, base + 1, base + 2, base, base + 2, base + 3)
    }
  }

  function emitLeavesAlongFinalBranch(sections) {
    const count = preset.leaves.count
    const radialOffset = random.value()
    const angularSlots = random.shuffledIndices(count)
    const step = (1 - preset.leaves.start) / count
    for (let slot = 0; slot < count; slot++) {
      const along = preset.leaves.start + (slot + random.value()) * step
      const parent = interpolateSection(sections, along)
      const azimuth = TAU * (radialOffset + (angularSlots[slot] + random.value(0.5, -0.5)) / count)
      const localTilt = new THREE.Quaternion().setFromAxisAngle(_X, THREE.MathUtils.degToRad(preset.leaves.angle))
      const localAzimuth = new THREE.Quaternion().setFromAxisAngle(_Y, azimuth)
      const parentQuaternion = new THREE.Quaternion().setFromEuler(parent.orientation)
      const orientation = new THREE.Euler().setFromQuaternion(parentQuaternion.multiply(localAzimuth.multiply(localTilt)))
      emitLeaf(parent.origin, orientation)
    }
  }

  function enqueueLateralChildren(parentLevel, sections) {
    const level = parentLevel + 1
    const count = preset.branch.children[parentLevel]
    const start = preset.branch.start[level]
    const radialOffset = random.value()
    const angularSlots = random.shuffledIndices(count)
    const step = (1 - start) / count
    for (let slot = 0; slot < count; slot++) {
      const along = start + (slot + random.value()) * step
      const parent = interpolateSection(sections, along)
      const azimuth = TAU * (radialOffset + (angularSlots[slot] + random.value(0.5, -0.5)) / count)
      const localTilt = new THREE.Quaternion().setFromAxisAngle(_X, THREE.MathUtils.degToRad(preset.branch.angle[level]))
      const localAzimuth = new THREE.Quaternion().setFromAxisAngle(_Y, azimuth)
      const parentQuaternion = new THREE.Quaternion().setFromEuler(parent.orientation)
      const orientation = new THREE.Euler().setFromQuaternion(parentQuaternion.multiply(localAzimuth.multiply(localTilt)))
      // a lateral's radius is the species factor times the parent's *interpolated* radius where it
      // leaves, so thickness follows emergence height rather than being a per-level constant
      jobs.push({
        origin: parent.origin, orientation, length: preset.branch.length[level],
        radius: preset.branch.radius[level] * parent.radius, level,
        sectionCount: preset.branch.sections[level], segmentCount: preset.branch.segments[level],
      })
    }
  }

  const radial = new THREE.Vector3(), vtx = new THREE.Vector3(), nrm = new THREE.Vector3()
  const sectionUp = new THREE.Vector3(), forceAxis = new THREE.Vector3(), step = new THREE.Vector3()

  while (jobs.length > 0) {
    const branch = jobs.shift()
    const emitWood = !(far && branch.level === preset.branchLevels) // far: finest twigs are sub-pixel
    const segs = far ? Math.max(3, Math.ceil(branch.segmentCount * 0.5)) : branch.segmentCount
    const indexOffset = B.p.length / 3
    const orientation = branch.orientation.clone()
    const origin = branch.origin.clone()
    const sectionLength = branch.length / branch.sectionCount
    const sections = []

    for (let sectionIndex = 0; sectionIndex <= branch.sectionCount; sectionIndex++) {
      let sectionRadius = branch.radius * (1 - preset.branch.taper[branch.level] * (sectionIndex / branch.sectionCount))
      if (sectionIndex === branch.sectionCount && branch.level === preset.branchLevels) sectionRadius = 0.001
      const along = sectionIndex * sectionLength
      const circumference = TAU * Math.max(sectionRadius, 0.02)

      if (emitWood) {
        // segs + 1 vertices: the seam repeats the first so the bark coordinate runs past the wrap
        for (let r = 0; r <= segs; r++) {
          const angle = (TAU * (r % segs)) / segs
          radial.set(Math.cos(angle), 0, Math.sin(angle))
          vtx.copy(radial).multiplyScalar(sectionRadius).applyEuler(orientation).add(origin)
          nrm.copy(radial).applyEuler(orientation).normalize()
          B.p.push(vtx.x, vtx.y, vtx.z); B.n.push(nrm.x, nrm.y, nrm.z)
          B.raw.push(vtx.y, branch.level); B.s.push(along, (r / segs) * circumference)
          if (vtx.y > maxY) maxY = vtx.y
        }
      }

      sections.push({ origin: origin.clone(), orientation: orientation.clone(), radius: sectionRadius })
      origin.add(step.set(0, sectionLength, 0).applyEuler(orientation))

      // gnarliness is amplified on thin limbs (1/sqrt(radius)): twigs wander, the bole does not
      const safeRadius = Math.max(sectionRadius, 0.001)
      const gnarliness = Math.max(1, 1 / Math.sqrt(safeRadius)) * preset.branch.gnarliness[branch.level]
      orientation.x += random.value(gnarliness, -gnarliness)
      orientation.z += random.value(gnarliness, -gnarliness)

      const sectionQuaternion = new THREE.Quaternion().setFromEuler(orientation)
      sectionQuaternion.multiply(new THREE.Quaternion().setFromAxisAngle(_Y, preset.branch.twist[branch.level]))
      // ...then turned back toward the growth force by an angle that scales as 1/radius
      sectionUp.set(0, 1, 0).applyQuaternion(sectionQuaternion)
      forceAxis.crossVectors(sectionUp, forceDirection)
      const sine = forceAxis.length()
      if (sine > 1e-6) {
        forceAxis.divideScalar(sine)
        const fullAngle = Math.atan2(sine, sectionUp.dot(forceDirection))
        const stepAngle = preset.branch.forceStrength / safeRadius
        sectionQuaternion.premultiply(new THREE.Quaternion().setFromAxisAngle(forceAxis, THREE.MathUtils.clamp(stepAngle, -fullAngle, fullAngle)))
      }
      orientation.setFromQuaternion(sectionQuaternion)
    }

    if (emitWood) {
      const ring = segs + 1
      for (let s = 0; s < branch.sectionCount; s++) {
        for (let r = 0; r < segs; r++) {
          const a = indexOffset + s * ring + r, b = a + 1, c = a + ring, d = b + ring
          B.i.push(a, c, b, b, c, d)
        }
      }
    }

    const finalSection = sections.at(-1)
    if (branch.level < preset.branchLevels) {
      // The terminal continuation: without it every limb ends where its laterals begin and the
      // crown is a candelabra. It inherits the parent's section and segment counts.
      jobs.push({
        origin: finalSection.origin, orientation: finalSection.orientation,
        length: preset.branch.length[branch.level + 1], radius: finalSection.radius, level: branch.level + 1,
        sectionCount: branch.sectionCount, segmentCount: branch.segmentCount,
      })
      enqueueLateralChildren(branch.level, sections)
    } else {
      emitLeaf(finalSection.origin, finalSection.orientation)
      emitLeavesAlongFinalBranch(sections)
    }
  }

  // ---- back-fill: metres, crown occlusion, sway weight
  const k = height / maxY
  for (let i = 0; i < B.p.length; i++) B.p[i] *= k
  for (let i = 0; i < B.s.length; i++) B.s[i] *= k
  for (let i = 0; i < L.p.length; i++) L.p[i] *= k

  const crown = new THREE.Vector3()
  for (const o of leafOrigins) crown.add(o)
  if (leafOrigins.length) crown.multiplyScalar(1 / leafOrigins.length)
  let crownR = 0
  for (const o of leafOrigins) crownR = Math.max(crownR, o.distanceTo(crown))
  crown.multiplyScalar(k)
  crownR = Math.max(crownR * k, 0.001)
  for (let li = 0; li < leafOrigins.length; li++) {
    const start = leafStart[li]
    if (start < 0) continue
    const outward = Math.min(1, leafOrigins[li].clone().multiplyScalar(k).distanceTo(crown) / crownR)
    for (let v = start; v < start + 8; v++) L.s[v * 2 + 1] = outward
  }

  // Sway weight is the whole wind model in one number: quadratic in height so the bole barely
  // moves, plus a branch-order term so a twig outruns the limb holding it.
  const sway = (raw, i) => {
    const h = Math.min(1, Math.max(0, raw[i * 2] / maxY))
    return h * h * (0.26 + raw[i * 2 + 1] * 0.13)
  }
  const bw = new Float32Array(B.raw.length)
  for (let i = 0; i < B.raw.length / 2; i++) bw[i * 2] = sway(B.raw, i)
  const lw = new Float32Array(L.raw.length)
  for (let i = 0; i < L.raw.length / 2; i++) { lw[i * 2] = sway(L.raw, i); lw[i * 2 + 1] = L.fl[i] }

  const bark = new THREE.BufferGeometry()
  bark.setAttribute('position', new THREE.Float32BufferAttribute(B.p, 3))
  bark.setAttribute('normal', new THREE.Float32BufferAttribute(B.n, 3))
  bark.setAttribute('aWind', new THREE.BufferAttribute(bw, 2))
  bark.setAttribute('aSurf', new THREE.Float32BufferAttribute(B.s, 2))
  bark.setIndex(B.i)
  const leaves = new THREE.BufferGeometry()
  leaves.setAttribute('position', new THREE.Float32BufferAttribute(L.p, 3))
  leaves.setAttribute('normal', new THREE.Float32BufferAttribute(L.n, 3))
  leaves.setAttribute('uv', new THREE.Float32BufferAttribute(L.uv, 2))
  leaves.setAttribute('aWind', new THREE.BufferAttribute(lw, 2))
  leaves.setAttribute('aSurf', new THREE.Float32BufferAttribute(L.s, 2))
  leaves.setIndex(L.i)
  for (const g of [bark, leaves]) { g.computeBoundingBox(); g.computeBoundingSphere() }
  return {
    bark, leaves, height,
    triangles: (B.i.length + L.i.length) / 3,
    crown: { x: crown.x, y: crown.y, z: crown.z, r: crownR },
  }
}

// ---------------------------------------------------------------------------------------------
// Coconut palm. A frond is pinnate: a drooping rachis carrying dozens of narrow leaflets that
// sweep back and hang. One quad per side is what makes a palm read as a paper toy; individual
// leaflets cost ~3 triangles each and buy the whole look. Built in local space (trunk base at the
// origin, the trunk curving toward +X) so one geometry serves every instance.
// ---------------------------------------------------------------------------------------------

const TRUNK_H = 7.0

function growPalm(seed, { lod = 0 } = {}) {
  const rand2 = lcg(seed)
  const far = lod > 0
  const RINGS = far ? 6 : 9, SIDES = far ? 5 : 7
  const FRONDS = 18, STATIONS = far ? 10 : 24
  const widen = far ? 1.9 : 1 // fewer, broader leaflets keep the far crown's coverage

  const T = { p: [], n: [], w: [], s: [], i: [] } // trunk + coconuts: aSurf = (0 trunk | 1 nut, along)
  const F = { p: [], n: [], w: [], s: [], i: [] } // fronds: aSurf = (frond random, along)
  let maxY = 0
  const vert = (A, pos, nor, along, a, flutter) => {
    const h = Math.min(Math.max(pos.y / TRUNK_H, 0), 1.25)
    A.p.push(pos.x, pos.y, pos.z)
    const l = Math.hypot(nor.x, nor.y, nor.z) || 1
    A.n.push(nor.x / l, nor.y / l, nor.z / l)
    A.w.push(h * h * 0.38, flutter)
    A.s.push(a, along)
    if (pos.y > maxY) maxY = pos.y
    return A.p.length / 3 - 1
  }

  // ---- trunk: bent tapered tube
  const bendX = 1.1
  const ringCenter = (t) => new THREE.Vector3(bendX * t * t, TRUNK_H * t, 0)
  const ringRadius = (t) => 0.15 * (1 - t * 0.45) + 0.09 * Math.max(0, 1 - t * 8)
  for (let ri = 0; ri <= RINGS; ri++) {
    const t = ri / RINGS, c = ringCenter(t), rad = ringRadius(t)
    for (let si = 0; si < SIDES; si++) {
      const a = (si / SIDES) * TAU
      vert(T, new THREE.Vector3(c.x + Math.cos(a) * rad, c.y, c.z + Math.sin(a) * rad), new THREE.Vector3(Math.cos(a), 0, Math.sin(a)), t, 0, 0)
    }
  }
  for (let ri = 0; ri < RINGS; ri++) {
    for (let si = 0; si < SIDES; si++) {
      const a = ri * SIDES + si, b = ri * SIDES + ((si + 1) % SIDES)
      T.i.push(a, a + SIDES, b, b, a + SIDES, b + SIDES)
    }
  }

  // ---- fronds: every age at once (young ones stand up, old ones fold past horizontal)
  const crown = ringCenter(1)
  const dir = new THREE.Vector3(), across = new THREE.Vector3(), nrm = new THREE.Vector3()
  const tip = new THREE.Vector3(), mid = new THREE.Vector3(), tmp = new THREE.Vector3()
  for (let f = 0; f < FRONDS; f++) {
    const az = (f / FRONDS) * TAU + (f % 2) * 0.27 + rand2() * 0.25
    const frondRand = (f * 0.6180339887 + rand2() * 0.1) % 1
    const Lf = 3.7 + frondRand * 1.35
    const age = (f * 0.37 + rand2() * 0.3) % 1
    const el0 = 0.95 - age * 0.95
    const droop = 1.15 + age * 1.5
    const dirH = new THREE.Vector2(Math.cos(az), Math.sin(az))
    const rib = [crown.clone()]
    for (let s = 1; s <= STATIONS; s++) {
      const t = s / STATIONS, el = el0 - droop * t * t, st = Lf / STATIONS
      const prev = rib[s - 1].clone()
      prev.x += Math.cos(el) * dirH.x * st
      prev.z += Math.cos(el) * dirH.y * st
      prev.y += Math.sin(el) * st
      rib.push(prev)
    }
    const perp = new THREE.Vector3(-dirH.y, 0, dirH.x)
    // the rachis: a thin spine so the frond has a stem, not a gap
    for (let s = 0; s < STATIONS; s++) {
      const t = s / STATIONS, t1 = t + 1 / STATIONS
      const w = 0.032 * (1 - t * 0.8) * (far ? 1.4 : 1)
      const a = rib[s], b = rib[s + 1], off = perp.clone().multiplyScalar(w)
      const i0 = vert(F, tmp.copy(a).sub(off), _Y, t, frondRand, t * t)
      const i1 = vert(F, tmp.copy(a).add(off), _Y, t, frondRand, t * t)
      const i2 = vert(F, tmp.copy(b).sub(off), _Y, t1, frondRand, t1 * t1)
      const i3 = vert(F, tmp.copy(b).add(off), _Y, t1, frondRand, t1 * t1)
      F.i.push(i0, i2, i1, i1, i2, i3)
    }
    for (let s = 1; s < STATIONS; s++) {
      const t = s / STATIONS, a = rib[s]
      // leaflets are longest a third of the way out and shrink to nothing at the tip
      const len = (0.40 + 0.92 * Math.sin(Math.min(t * 3.4, Math.PI * 0.86))) * (0.85 + frondRand * 0.3)
      dir.subVectors(rib[s + 1] || rib[s], rib[s - 1]).normalize()
      for (const side of [-1, 1]) {
        // swept toward the tip and dropped: the two rotations that make a leaflet look grown
        const jitter = ((s * 7 + (side + 1) * 3 + f * 13) % 11) / 11
        const sweep = 0.34 + jitter * 0.16
        const drop = (0.30 + jitter * 0.35) * len * (0.4 + t)
        across.copy(perp).multiplyScalar(side * (1 - sweep)).addScaledVector(dir, sweep).normalize()
        tip.copy(a).addScaledVector(across, len); tip.y -= drop
        mid.copy(a).addScaledVector(across, len * 0.52); mid.y -= drop * 0.20
        nrm.crossVectors(across, dir).normalize()
        if (nrm.y < 0) nrm.negate()
        const wr = (0.055 + jitter * 0.018) * widen, wm = wr * 0.72
        const tm = t + 0.03, tt = t + 0.06
        const r0 = vert(F, tmp.copy(a).addScaledVector(dir, -wr), nrm, t, frondRand, t * t)
        const r1 = vert(F, tmp.copy(a).addScaledVector(dir, wr), nrm, t, frondRand, t * t)
        const m0 = vert(F, tmp.copy(mid).addScaledVector(dir, -wm), nrm, tm, frondRand, tm * tm)
        const m1 = vert(F, tmp.copy(mid).addScaledVector(dir, wm), nrm, tm, frondRand, tm * tm)
        const tp = vert(F, tip, nrm, tt, frondRand, tt * tt)
        F.i.push(r0, m0, r1, r1, m0, m1, m0, tp, m1)
      }
    }
  }

  // ---- coconuts: six triangles apiece, and most of what says *coconut* palm rather than a fern
  // on a pole. Octahedra smoothed by their own normals, tucked under the frond bases.
  const NUTS = 3 + Math.floor(rand2() * 4)
  const DIRS = [[0, 1, 0], [1, 0, 0], [0, 0, 1], [-1, 0, 0], [0, 0, -1], [0, -1, 0]]
  for (let k = 0; k < NUTS; k++) {
    const az = rand2() * TAU, r = 0.20 + rand2() * 0.16
    const c = new THREE.Vector3(crown.x + Math.cos(az) * r, crown.y - 0.18 - rand2() * 0.28, crown.z + Math.sin(az) * r)
    const R = 0.14 + rand2() * 0.05
    const first = T.p.length / 3
    for (const [dx, dy, dz] of DIRS) vert(T, tmp.set(c.x + dx * R, c.y + dy * R * 1.15, c.z + dz * R), new THREE.Vector3(dx, dy, dz), 0, 1, 0)
    for (let e = 0; e < 4; e++) {
      const a = first + 1 + e, b = first + 1 + ((e + 1) % 4)
      T.i.push(first, a, b, first + 5, b, a)
    }
  }

  const make = (A) => {
    const g = new THREE.BufferGeometry()
    g.setAttribute('position', new THREE.Float32BufferAttribute(A.p, 3))
    g.setAttribute('normal', new THREE.Float32BufferAttribute(A.n, 3))
    g.setAttribute('aWind', new THREE.Float32BufferAttribute(A.w, 2))
    g.setAttribute('aSurf', new THREE.Float32BufferAttribute(A.s, 2))
    g.setIndex(A.i)
    g.computeBoundingBox(); g.computeBoundingSphere()
    return g
  }
  return {
    bark: make(T), leaves: make(F), height: maxY,
    triangles: (T.i.length + F.i.length) / 3,
    crown: { x: crown.x, y: crown.y - 0.6, z: crown.z, r: 4.2 },
  }
}

// ---------------------------------------------------------------------------------------------
// Shading. Built-in MeshStandardMaterial patched with onBeforeCompile, so shadows, fog, the
// environment map, hemisphere light and log depth keep working. The wind is applied to
// `transformed` (before the instance / batch matrix), converting a world-space offset into the
// object's frame, so it works for Mesh, InstancedMesh and BatchedMesh and for the shadow pass.
// ---------------------------------------------------------------------------------------------

const VERT_PARS = /* glsl */`
attribute vec2 aWind;
attribute vec2 aSurf;
uniform float uFloraTime;
uniform vec4 uFloraWind;   // world wind dir (x, z), level 0..1, unused
uniform vec2 uFloraInst;   // phase, tint for a single (non-batched) tree
varying vec2 vSurf;
varying float vTint;
float floraHash( vec2 p ) { return fract( sin( dot( p, vec2( 127.1, 311.7 ) ) ) * 43758.5453123 ); }
`

// per kind: the world-space wind offset `off` from sway level L, phase ph, size sc
const WIND = {
  // whole-crown sway weighted by height^2 and branch order, plus a fast per-leaf flutter applied
  // perpendicular to the wind (a shoot on a stalk pivots, it does not surge), rooted at the stalk
  ash: /* glsl */`
    float swayL = ( 0.18 + 0.55 * L ) * smoothstep( 0.0, 0.08, L );
    float flutL = ( swayL * 1.6 + 0.25 ) * smoothstep( 0.0, 0.08, L );
    float sway = ( sin( uFloraTime * 0.78 + ph ) * 0.62 + sin( uFloraTime * 0.29 + ph * 1.7 ) * 0.48 ) * swayL * sc;
    vec3 off = vec3( uFloraWind.x, 0.0, uFloraWind.y ) * ( aWind.x * sway );
    float rr = ph + aSurf.x * 41.0;
    float amp = aWind.y * flutL * 0.16 * sc;
    off.y += sin( uFloraTime * 4.4 + rr ) * amp;
    float sideways = sin( uFloraTime * 3.3 + rr * 1.7 ) * amp;
    off.x += uFloraWind.y * sideways;
    off.z -= uFloraWind.x * sideways;`,
  // whole-crown sway + frond-tip flutter along the frond
  palm: /* glsl */`
    float swayL = ( 0.16 + 0.5 * L ) * smoothstep( 0.0, 0.08, L );
    float flutL = ( swayL * 2.5 + 0.35 ) * smoothstep( 0.0, 0.08, L );
    float sway = ( sin( uFloraTime * 1.15 + ph ) * 0.5 + sin( uFloraTime * 0.37 + ph * 1.7 ) ) * swayL * sc;
    vec3 off = vec3( uFloraWind.x, 0.0, uFloraWind.y ) * ( aWind.x * sway );
    off.y += sin( uFloraTime * 5.2 + aSurf.x * 31.0 + aSurf.y * 9.0 + ph ) * aWind.y * 0.10 * flutL * sc;`,
}

const beginVertex = (kind) => /* glsl */`
vec3 transformed = vec3( position );
{
  mat4 floraM = modelMatrix;
  #ifdef USE_BATCHING
    floraM = floraM * batchingMatrix;
  #endif
  #ifdef USE_INSTANCING
    floraM = floraM * instanceMatrix;
  #endif
  mat3 floraR = mat3( floraM );
  float floraS2 = dot( floraR[ 0 ], floraR[ 0 ] );
  float sc = sqrt( floraS2 );
  #if defined( USE_BATCHING ) || defined( USE_INSTANCING )
    float ph = floraHash( floraM[ 3 ].xz ) * 6.2831853;
    vTint = floraHash( floraM[ 3 ].xz + 17.31 );
  #else
    float ph = uFloraInst.x;
    vTint = uFloraInst.y;
  #endif
  float L = uFloraWind.z;
  ${WIND[kind]}
  transformed += transpose( floraR ) * off / floraS2;
  vSurf = aSurf;
}
`

const FRAG_PARS = /* glsl */`
uniform vec3 uFloraA;   // per-kind colour slots (see each kind)
uniform vec3 uFloraB;
uniform vec3 uFloraC;
uniform float uFloraTrans;  // transmission strength
uniform float uFloraAO;     // canopy self-occlusion floor
varying vec2 vSurf;
varying float vTint;
float floraHash( vec2 p ) { return fract( sin( dot( p, vec2( 127.1, 311.7 ) ) ) * 43758.5453123 ); }
float floraNoise( vec2 p ) {
  vec2 i = floor( p ), f = fract( p );
  vec2 w = f * f * ( 3.0 - 2.0 * f );
  float a = floraHash( i ), b = floraHash( i + vec2( 1.0, 0.0 ) );
  float c = floraHash( i + vec2( 0.0, 1.0 ) ), d = floraHash( i + vec2( 1.0, 1.0 ) );
  return mix( mix( a, b, w.x ), mix( c, d, w.x ), w.y );
}
`

// Foliage: two-sided diffuse (a back-lit leaf still gets a share) and a transmission lobe, the
// whole look of a broadleaf at golden hour. Added per light inside three's own light loop, so
// directLight.color already carries the shadow map.
const FOLIAGE_LIGHT = (pow) => /* glsl */`
#include <lights_physical_pars_fragment>
vec3 fTrans = vec3( 0.0 );
float fBack = 0.0;
void RE_Direct_Foliage( const in IncidentLight directLight, const in vec3 geometryPosition, const in vec3 geometryNormal, const in vec3 geometryViewDir, const in vec3 geometryClearcoatNormal, const in PhysicalMaterial material, inout ReflectedLight reflectedLight ) {
  RE_Direct_Physical( directLight, geometryPosition, geometryNormal, geometryViewDir, geometryClearcoatNormal, material, reflectedLight );
  float ndl = dot( geometryNormal, directLight.direction );
  reflectedLight.directDiffuse += max( - ndl, 0.0 ) * fBack * directLight.color * BRDF_Lambert( material.diffuseContribution );
  float back = saturate( dot( - geometryViewDir, directLight.direction ) );
  reflectedLight.directDiffuse += fTrans * directLight.color * ( RECIPROCAL_PI * pow( back, ${pow.toFixed(2)} ) );
}
#undef RE_Direct
#define RE_Direct RE_Direct_Foliage
`

// Bark is fissured, and a fissure is a crease: aperiodic value noise folded through abs, in the
// limb's own surface frame (metres around, metres along squashed 18:1) so cracks run the way the
// tree grew. Two crack sets combined with min plus one across to break ridges into plates, and
// band-limited by hand because a procedural field has no mip chain.
const ASH_BARK = /* glsl */`
{
  vec2 bq = vec2( vSurf.y, vSurf.x * 0.055 );
  float detail = smoothstep( 44.0, 12.0, length( vViewPosition ) );
  float warp = ( floraNoise( bq * vec2( 6.0, 26.0 ) ) - 0.5 ) * 0.022;
  vec2 bw = vec2( bq.x + warp, bq.y );
  float deep = smoothstep( 0.010, 0.150, abs( floraNoise( bw * 30.0 ) - 0.5 ) );
  float fine = smoothstep( 0.020, 0.190, abs( floraNoise( bw * 66.0 + 11.3 ) - 0.5 ) );
  float acrossC = smoothstep( 0.030, 0.230, abs( floraNoise( vec2( bw.x * 0.25, bw.y * 3.0 ) * 30.0 + 41.0 ) - 0.5 ) );
  float sh1 = fine * detail * 0.42 + 1.0 - detail * 0.42;
  float sh2 = acrossC * detail * 0.34 + 1.0 - detail * 0.34;
  float crease = mix( 0.72, min( deep, min( sh1, sh2 ) ), detail );
  float plate = floraNoise( bq * 4.5 + 31.7 );
  float grain = ( floraNoise( bq * vec2( 210.0, 34.0 ) + 63.1 ) - 0.5 ) * detail * 0.16;
  vec3 bark = mix( uFloraA, uFloraB, clamp( crease * ( plate * 0.30 + 0.70 ) + grain, 0.0, 1.0 ) );
  bark *= crease * 0.14 + 0.92;
  diffuseColor.rgb *= bark * ( crease * 0.20 + 0.80 );
}
`

// Leaf: the photographed spray carries within-spray variation; what is added is between trees
// (olive to nearly yellow per instance) and the crown's inside (occlusion by outwardness).
const ASH_LEAF = /* glsl */`
{
  #ifdef USE_MAP
    // keep coverage in the mips: averaged alpha would thin the far canopy to nothing
    vec2 ts = vec2( textureSize( map, 0 ) );
    vec2 dx = dFdx( vMapUv * ts ), dy = dFdy( vMapUv * ts );
    float mip = max( 0.0, 0.5 * log2( max( dot( dx, dx ), dot( dy, dy ) ) ) );
    diffuseColor.a *= 1.0 + mip * 0.22;
  #endif
  vec3 green = diffuseColor.rgb;
  green = mix( green, green * uFloraA, pow( vTint, 1.6 ) );
  green *= vSurf.x * 0.22 + 0.89;
  float canopyAO = mix( uFloraAO, 1.0, pow( vSurf.y, 1.5 ) );
  fTrans = mix( green, green * uFloraB, 0.35 ) * 1.15 * uFloraTrans * ( vSurf.y * 0.75 + 0.25 );
  fBack = 0.28;
  diffuseColor.rgb = green * canopyAO;
}
`

// Palm trunk (fibre bands and ring scars) and coconuts (aSurf.x = 1).
const PALM_BARK = /* glsl */`
{
  float y = vSurf.y * 7.0;
  float tone = sin( y * 14.0 ) * 0.08 + sin( y * 3.1 ) * 0.06 + 1.0;
  float scar = 1.0 - 0.18 * smoothstep( 0.82, 1.0, sin( y * 9.0 ) * 0.5 + 0.5 );
  vec3 col = vSurf.x > 0.5 ? uFloraB * 0.9 : uFloraA * tone * scar;
  diffuseColor.rgb *= col;
}
`

// Palm fronds: deep green to dry tips, per-frond variation; the middle of the crown sits in its
// own shade all day, and transmission fades toward the rachis base.
const PALM_FROND = /* glsl */`
{
  vec3 frond = mix( uFloraA, uFloraB, vSurf.x * 0.85 ) * mix( 1.0, 0.66, smoothstep( 0.45, 1.0, vSurf.y ) );
  frond *= 0.92 + 0.16 * vTint;
  float crownAO = mix( 0.52, 1.0, smoothstep( 0.0, 0.55, vSurf.y ) );
  fTrans = frond * diffuseColor.rgb * 0.85 * uFloraTrans * smoothstep( 0.05, 0.6, vSurf.y );
  fBack = 0.35;
  diffuseColor.rgb *= frond * crownAO;
}
`

function patchMaterial(material, kind, frag, uniforms, foliagePow) {
  material.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, uniforms)
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\n' + VERT_PARS)
      .replace('#include <begin_vertex>', beginVertex(kind.split('-')[0]))
    let fs = shader.fragmentShader
      .replace('#include <common>', '#include <common>\n' + FRAG_PARS)
      .replace('#include <map_fragment>', '#include <map_fragment>\n' + frag)
    if (foliagePow) fs = fs.replace('#include <lights_physical_pars_fragment>', FOLIAGE_LIGHT(foliagePow))
    shader.fragmentShader = fs
  }
  material.customProgramCacheKey = () => 'flora-' + kind
  return material
}

function depthMaterial(kind, uniforms) {
  const m = new THREE.MeshDepthMaterial()
  m.name = 'flora shadow · ' + kind
  m.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, uniforms)
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\n' + VERT_PARS)
      .replace('#include <begin_vertex>', beginVertex(kind))
  }
  m.customProgramCacheKey = () => 'flora-depth-' + kind
  return m
}

// ---------------------------------------------------------------------------------------------
// Textures: loaded once per URL (the image), a fresh Texture per factory call.
// ---------------------------------------------------------------------------------------------

const imageCache = new Map()
function loadImage(url) {
  if (!imageCache.has(url)) imageCache.set(url, new THREE.ImageLoader().loadAsync(url).catch((error) => {
    imageCache.delete(url)
    throw error
  }))
  return imageCache.get(url)
}

async function leafTexture(url) {
  let image
  try {
    image = await loadImage(url)
  } catch {
    console.warn(`trees.js: leaf texture ${url} not found. Copy src/environment/assets/ash-leaf.png to public${url}. Using flat cards.`)
    const data = new Uint8Array([72, 110, 50, 255])
    const t = new THREE.DataTexture(data, 1, 1)
    t.colorSpace = THREE.SRGBColorSpace
    t.needsUpdate = true
    return t
  }
  const tex = new THREE.Texture(image)
  tex.colorSpace = THREE.SRGBColorSpace
  tex.anisotropy = 4
  tex.needsUpdate = true
  return tex
}

// ---------------------------------------------------------------------------------------------
// Shared per-call state: uniforms, wind gusting, materials for one species.
// ---------------------------------------------------------------------------------------------

// Gust envelope, a pure function of absolute time: the breeze rises and falls on a ~30 s swell
// with a faster flicker on top, so a still frame at any t is reproducible.
export function gustLevel(time, wind) {
  const g = 0.5 + 0.32 * Math.sin(time * 0.21 + 1.3 * Math.sin(time * 0.057)) + 0.18 * Math.sin(time * 0.53 + 0.7)
  return wind * (0.62 + 0.38 * Math.min(1, Math.max(0, g)))
}

function makeWindState(wind, windDirection) {
  const uniforms = {
    uFloraTime: { value: 0 },
    uFloraWind: { value: new THREE.Vector4(1, 0, wind, 0) },
  }
  const state = { wind, dir: windDirection, time: 0 }
  const apply = () => {
    uniforms.uFloraWind.value.set(Math.cos(state.dir), Math.sin(state.dir), gustLevel(state.time, state.wind), 0)
    uniforms.uFloraTime.value = state.time
  }
  apply()
  return {
    uniforms,
    update(time) { if (time === state.time) return; state.time = time; apply() },
    setWind(wind, direction = state.dir) { state.wind = wind; state.dir = direction; apply() },
  }
}

async function speciesMaterials(name, windUniforms, textureBase, label) {
  const sp = TREE_SPECIES[name]
  const u = (extra) => ({ ...windUniforms, uFloraInst: { value: new THREE.Vector2(0, 0.35) }, ...extra })
  if (sp.kind === 'palm') {
    const barkU = u({
      uFloraA: { value: srgb(0.40, 0.34, 0.27) }, uFloraB: { value: srgb(0.30, 0.22, 0.11) },
      uFloraC: { value: new THREE.Color() }, uFloraTrans: { value: 1 }, uFloraAO: { value: 1 },
    })
    const leafU = u({
      uFloraA: { value: srgb(0.09, 0.21, 0.07) }, uFloraB: { value: srgb(0.26, 0.36, 0.11) },
      uFloraC: { value: new THREE.Color() }, uFloraTrans: { value: 1 }, uFloraAO: { value: 1 },
    })
    const bark = patchMaterial(new THREE.MeshStandardMaterial({ name: `${label} · Trunk & coconuts`, roughness: 0.92 }), 'palm-bark', PALM_BARK, barkU)
    const leaves = patchMaterial(new THREE.MeshStandardMaterial({ name: `${label} · Fronds`, roughness: 0.7, side: THREE.DoubleSide }), 'palm-frond', PALM_FROND, leafU, 3.0)
    return { bark, leaves, barkU, leafU, barkDepth: depthMaterial('palm', barkU), leafDepth: depthMaterial('palm', leafU), textures: [] }
  }
  const map = await leafTexture(textureBase + sp.leafTexture)
  const barkU = u({
    uFloraA: { value: sp.bark.dark.clone() }, uFloraB: { value: sp.bark.light.clone() },
    uFloraC: { value: new THREE.Color() }, uFloraTrans: { value: 1 }, uFloraAO: { value: 1 },
  })
  const leafU = u({
    uFloraA: { value: srgb(1.28, 1.14, 0.62) }, uFloraB: { value: srgb(1.35, 1.20, 0.45) },
    uFloraC: { value: new THREE.Color() }, uFloraTrans: { value: 1 }, uFloraAO: { value: 0.22 },
  })
  const bark = patchMaterial(new THREE.MeshStandardMaterial({ name: `${label} · Bark`, roughness: 0.95 }), 'ash-bark', ASH_BARK, barkU)
  // alphaTest 0.5 is the contract's value: lower and the cards show their corners as a grey haze
  const leaves = patchMaterial(new THREE.MeshStandardMaterial({ name: `${label} · Leaves`, roughness: 0.72, side: THREE.DoubleSide, map, alphaTest: 0.5 }), 'ash-leaf', ASH_LEAF, leafU, 2.6)
  return { bark, leaves, barkU, leafU, barkDepth: depthMaterial('ash', barkU), leafDepth: depthMaterial('ash', leafU), textures: [map] }
}

const geometryCache = new Map() // per page: same species + seed + height + lod -> same geometry data
function growVariant(name, variant, lod, height) {
  const sp = TREE_SPECIES[name]
  const key = `${name}|${variant.seed}|${height ?? variant.height}|${lod}`
  if (geometryCache.has(key)) {
    const g = geometryCache.get(key)
    return { ...g, bark: g.bark.clone(), leaves: g.leaves.clone() }
  }
  const g = sp.kind === 'palm'
    ? growPalm(variant.seed, { lod })
    : growSystemTree({ ...sp.preset, seed: variant.seed }, { height: height ?? variant.height, lod })
  geometryCache.set(key, g)
  return { ...g, bark: g.bark.clone(), leaves: g.leaves.clone() }
}

function resolveSpecies(name) {
  const key = String(name || 'ash').toLowerCase()
  if (!TREE_SPECIES[key]) throw new Error(`trees.js: unknown species "${name}" (${Object.keys(TREE_SPECIES).join(' | ')})`)
  return key
}

// ---------------------------------------------------------------------------------------------
// createTree: one hero tree, a Group of two meshes (bark, leaves), editable as one object.
// rebuild(options) regrows it in place and keeps the same Group, meshes and material instances
// (Edit3D's material panel keys materials by scene path: fresh materials would collide and drop
// the user's material edits).
// ---------------------------------------------------------------------------------------------

const TREE_DEFAULTS = {
  species: 'ash', seed: undefined, height: undefined, lean: 0, leanDirection: 0, tint: 0.35, lod: 0,
  castShadow: true, receiveShadow: true, leafShadows: false, wind: 0.35, windDirection: 0.35, textureBase: '/environment/',
}

function materialCache(windState, getBase) {
  const cache = new Map()
  return {
    get(name, label) {
      const key = `${name}|${label}`
      if (!cache.has(key)) cache.set(key, speciesMaterials(name, windState.uniforms, getBase(), label))
      return cache.get(key)
    },
    dispose() {
      for (const p of cache.values()) p.then((m) => {
        for (const x of [m.bark, m.leaves, m.barkDepth, m.leafDepth]) x.dispose()
        for (const t of m.textures) t.dispose()
      })
      cache.clear()
    },
  }
}

export async function createTree(options = {}) {
  let opts = { ...TREE_DEFAULTS, ...options }
  const windState = makeWindState(opts.wind, opts.windDirection)
  const mats = materialCache(windState, () => opts.textureBase)
  const object = new THREE.Group()
  const bark = new THREE.Mesh(), leaves = new THREE.Mesh()
  bark.geometry.dispose(); leaves.geometry.dispose()
  object.add(bark, leaves)
  let geo = null, current = null, stats = null, crown = null, height = 0

  async function build() {
    const t0 = performance.now()
    const name = resolveSpecies(opts.species)
    const sp = TREE_SPECIES[name]
    const isPalm = sp.kind === 'palm'
    const m = await mats.get(name, sp.label)
    const vseed = opts.seed ?? sp.variants[0].seed
    const h = opts.height ?? sp.defaultHeight
    const g = growVariant(name, { seed: vseed, height: h }, opts.lod, isPalm ? undefined : h)
    const scale = isPalm ? h / g.height : 1
    const phase = lcg(vseed + 11)() * TAU
    for (const U of [m.barkU, m.leafU]) U.uFloraInst.value.set(phase, opts.tint)

    geo?.bark.dispose(); geo?.leaves.dispose()
    geo = g; current = m
    object.name = `${sp.label} tree`
    bark.name = `${sp.label} trunk`
    leaves.name = `${sp.label} ${isPalm ? 'fronds' : 'leaves'}`
    bark.geometry = g.bark; bark.material = m.bark; bark.customDepthMaterial = m.barkDepth
    leaves.geometry = g.leaves; leaves.material = m.leaves; leaves.customDepthMaterial = m.leafDepth
    // a tree leans from its base, about the horizontal axis perpendicular to leanDirection
    const lean = isPalm ? (opts.lean || 0.08) : opts.lean
    const tilt = new THREE.Quaternion().setFromAxisAngle(
      new THREE.Vector3(Math.cos(opts.leanDirection), 0, Math.sin(opts.leanDirection)).cross(_Y).normalize(), lean)
    for (const mesh of [bark, leaves]) {
      // crowns are shaded by their canopy-AO term, not the shadow map (as in the original): a
      // shadow-mapped crown self-shadows into a dark mass. leafShadows: true turns it on.
      mesh.castShadow = opts.castShadow; mesh.receiveShadow = opts.receiveShadow && (mesh === bark || opts.leafShadows)
      mesh.scale.setScalar(scale); mesh.quaternion.copy(tilt); mesh.position.y = -(sp.sink ?? 0) * scale
    }
    crown = { x: g.crown.x * scale, y: g.crown.y * scale, z: g.crown.z * scale, r: g.crown.r * scale }
    height = g.height * scale
    stats = { triangles: g.triangles, draws: 2, shadowDraws: opts.castShadow ? 2 : 0, buildMs: +(performance.now() - t0).toFixed(1) }
  }
  await build()

  return {
    object, bark, leaves,
    get materials() { return { bark: current.bark, leaves: current.leaves } },
    get crown() { return crown },
    get height() { return height },
    get stats() { return stats },
    get options() { return { ...opts } },
    update: windState.update,
    setWind: windState.setWind,
    setTint(v) { opts.tint = v; for (const U of [current.barkU, current.leafU]) U.uFloraInst.value.y = v },
    async rebuild(o = {}) {
      opts = { ...opts, ...o }
      if ('wind' in o || 'windDirection' in o) windState.setWind(opts.wind, opts.windDirection)
      await build()
    },
    dispose() { geo?.bark.dispose(); geo?.leaves.dispose(); mats.dispose() },
  }
}

// ---------------------------------------------------------------------------------------------
// Placement: rejection sampling inside an area, clustered into stands by two octaves of rotated
// value noise, with a minimum spacing that varies with the stand field (thick ground packs to
// ~4.5 m, thin ground opens out to ~11 m; a flat minimum everywhere gives an orchard).
// ---------------------------------------------------------------------------------------------

export function organicNoise(x, z, frequency, seed) {
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

function areaSampler(area, rnd) {
  const cx = area.x ?? area.center?.[0] ?? 0, cz = area.z ?? area.center?.[1] ?? 0
  if (area.radius != null) {
    return () => { const a = rnd() * TAU, d = Math.sqrt(rnd()) * area.radius; return [cx + Math.cos(a) * d, cz + Math.sin(a) * d] }
  }
  const w = area.width ?? area.size ?? 100, d = area.depth ?? area.size ?? w
  return () => [cx + (rnd() - 0.5) * w, cz + (rnd() - 0.5) * d]
}

function normalizeMix(species) {
  if (typeof species === 'string') return [{ name: resolveSpecies(species), w: 1 }]
  const list = Object.entries(species).filter(([, w]) => w > 0).map(([name, w]) => ({ name: resolveSpecies(name), w }))
  const total = list.reduce((a, b) => a + b.w, 0) || 1
  let acc = 0
  for (const e of list) { acc += e.w / total; e.w = acc }
  return list
}

function scatterTrees({ area, count, heightAt, mask, seed, spacing, clustering, maxSlope, rnd }) {
  const sample = areaSampler(area, rnd)
  const out = []
  const slope = (x, z) => {
    const d = 2
    return Math.hypot(heightAt(x + d, z) - heightAt(x - d, z), heightAt(x, z + d) - heightAt(x, z - d)) / (2 * d)
  }
  const gate = 0.32 * clustering
  for (let attempt = 0; attempt < count * 200 && out.length < count; attempt++) {
    const [x, z] = sample()
    if (mask) { const m = mask(x, z); if (!(m > 0) || rnd() > m) continue }
    const stand = clustering > 0 ? 0.64 * organicNoise(x, z, 0.011, seed % 997) + 0.36 * organicNoise(x, z, 0.027, (seed * 7) % 991) : 1
    if (stand < gate) continue
    if (maxSlope != null && slope(x, z) > maxSlope) continue
    const sp = clustering > 0
      ? spacing * (1 + clustering * (0.45 - 0.85 * Math.min(1, Math.max(0, (stand - 0.32) / 0.5))))
      : spacing
    let ok = true
    for (const t of out) { const dx = t.x - x, dz = t.z - z; if (dx * dx + dz * dz < sp * sp) { ok = false; break } }
    if (ok) out.push({ x, z })
  }
  return out
}


// ---------------------------------------------------------------------------------------------
// createForest: many trees. Per species: one BatchedMesh for bark and one for foliage holding all
// variants at two LODs; each tree is one batch instance with per-tree frustum culling, front-to-back
// sorting and a near/far geometry chosen from the *view* camera before every colour and shadow
// pass. Per-tree wind phase and canopy tint are hashed from the tree's position in the vertex stage.
// rebuild(options) re-scatters in place, keeping the Group and the material instances.
// ---------------------------------------------------------------------------------------------

const FOREST_DEFAULTS = {
  species: 'ash', area: { x: 0, z: 0, radius: 60 }, points: null, count: 80,
  heightAt: () => 0, mask: null, seed: 1, spacing: 7.5, clustering: 0.6, maxSlope: 0.72,
  variants: 5, lodDistance: 55, castShadow: true, receiveShadow: true, leafShadows: false,
  wind: 0.35, windDirection: 0.35, leanDirection: null, textureBase: '/environment/',
}

export async function createForest(options = {}) {
  let opts = { ...FOREST_DEFAULTS, ...options }
  const windState = makeWindState(opts.wind, opts.windDirection)
  const mats = materialCache(windState, () => opts.textureBase)
  const object = new THREE.Group()
  object.name = 'Forest'
  let meshes = [], stats = null, positions = []
  const _m = new THREE.Matrix4(), _q = new THREE.Quaternion(), _q2 = new THREE.Quaternion()
  const _p = new THREE.Vector3(), _s = new THREE.Vector3(), _axis = new THREE.Vector3()
  const baseRender = THREE.BatchedMesh.prototype.onBeforeRender

  async function build() {
    const t0 = performance.now()
    const mix = normalizeMix(opts.species)
    const rnd = lcg(opts.seed * 7919 + 104729)
    const spots = opts.points
      ? opts.points.map((p) => Array.isArray(p) ? { x: p[0], z: p[1] } : { x: p.x, z: p.z, y: p.y })
      : scatterTrees({ ...opts, rnd })
    const perSpecies = new Map()
    for (const s of spots) {
      const r = rnd()
      const name = (mix.find((e) => r <= e.w) || mix[mix.length - 1]).name
      if (!perSpecies.has(name)) perSpecies.set(name, [])
      perSpecies.get(name).push(s)
    }

    const fresh = []
    const st = { trees: spots.length, triangles: 0, trianglesFar: 0, draws: 0, shadowDraws: 0, species: {} }
    for (const [name, list] of perSpecies) {
      const sp = TREE_SPECIES[name]
      const m = await mats.get(name, `${sp.label} wood`)
      const vlist = sp.variants.slice(0, Math.max(1, Math.min(opts.variants, sp.variants.length)))
      const grown = vlist.map((v) => [growVariant(name, v, 0), growVariant(name, v, 1)])
      let vB = 0, iB = 0, vL = 0, iL = 0
      for (const pair of grown) for (const g of pair) {
        vB += g.bark.attributes.position.count; iB += g.bark.index.count
        vL += g.leaves.attributes.position.count; iL += g.leaves.index.count
      }
      const barkBM = new THREE.BatchedMesh(list.length, vB, iB, m.bark)
      const leafBM = new THREE.BatchedMesh(list.length, vL, iL, m.leaves)
      barkBM.name = `${sp.label} wood · trunks`
      leafBM.name = `${sp.label} wood · ${sp.kind === 'palm' ? 'fronds' : 'leaves'}`
      const ids = grown.map(([near, far]) => ({
        bark: [barkBM.addGeometry(near.bark), barkBM.addGeometry(far.bark)],
        leaf: [leafBM.addGeometry(near.leaves), leafBM.addGeometry(far.leaves)],
      }))
      for (const pair of grown) for (const g of pair) { g.bark.dispose(); g.leaves.dispose() }

      const pos = new Float32Array(list.length * 3)
      const variantOf = new Uint8Array(list.length)
      const isFar = new Uint8Array(list.length)
      const isPalm = sp.kind === 'palm'
      let tris = 0, trisFar = 0
      list.forEach((t, i) => {
        const vi = Math.floor(rnd() * vlist.length)
        variantOf[i] = vi
        const s = sp.scale[0] + rnd() * (sp.scale[1] - sp.scale[0])
        const rot = rnd() * TAU
        const lean = isPalm ? 0.04 + rnd() * (sp.lean - 0.04) : (rnd() - 0.5) * 2 * sp.lean
        const ld = (opts.leanDirection ?? rnd() * TAU) + (opts.leanDirection != null ? (rnd() - 0.5) * 0.9 : 0)
        _axis.set(Math.cos(ld), 0, Math.sin(ld)).cross(_Y).normalize()
        if (isPalm) _q.setFromAxisAngle(_axis, lean).multiply(_q2.setFromAxisAngle(_Y, rot))
        else _q.setFromAxisAngle(_Y, rot).multiply(_q2.setFromAxisAngle(_axis, lean))
        const y = (t.y ?? opts.heightAt(t.x, t.z)) - sp.sink * s
        _p.set(t.x, y, t.z); _s.setScalar(s)
        _m.compose(_p, _q, _s)
        barkBM.setMatrixAt(barkBM.addInstance(ids[vi].bark[0]), _m)
        leafBM.setMatrixAt(leafBM.addInstance(ids[vi].leaf[0]), _m)
        pos[i * 3] = t.x; pos[i * 3 + 1] = y + grown[vi][0].crown.y * s * 0.6; pos[i * 3 + 2] = t.z
        tris += grown[vi][0].triangles; trisFar += grown[vi][1].triangles
      })

      // ---- LOD: near/far per tree from the view camera (also before the shadow pass, so the
      // shadow matches what is drawn)
      const lod2 = opts.lodDistance * opts.lodDistance
      const camLocal = new THREE.Vector3(), inv = new THREE.Matrix4()
      let lastKey = null
      const selectLod = (camera) => {
        inv.copy(object.matrixWorld).invert()
        camLocal.setFromMatrixPosition(camera.matrixWorld).applyMatrix4(inv)
        const key = `${camLocal.x.toFixed(2)},${camLocal.y.toFixed(2)},${camLocal.z.toFixed(2)}`
        if (key === lastKey) return
        lastKey = key
        for (let i = 0; i < list.length; i++) {
          const dx = pos[i * 3] - camLocal.x, dy = pos[i * 3 + 1] - camLocal.y, dz = pos[i * 3 + 2] - camLocal.z
          const f = dx * dx + dy * dy + dz * dz > lod2 ? 1 : 0
          if (f !== isFar[i]) {
            isFar[i] = f
            barkBM.setGeometryIdAt(i, ids[variantOf[i]].bark[f])
            leafBM.setGeometryIdAt(i, ids[variantOf[i]].leaf[f])
          }
        }
      }
      for (const [bm, depth] of [[barkBM, m.barkDepth], [leafBM, m.leafDepth]]) {
        bm.customDepthMaterial = depth
        bm.castShadow = opts.castShadow
        bm.receiveShadow = opts.receiveShadow && (bm === barkBM || opts.leafShadows)
        bm.onBeforeRender = function (renderer, scene, camera, geometry, material, group) {
          if (!camera.isArrayCamera) selectLod(camera)
          baseRender.call(this, renderer, scene, camera, geometry, material, group)
        }
        bm.onBeforeShadow = function (renderer, obj, camera, shadowCamera, geometry, depthMaterial) {
          selectLod(camera)
          baseRender.call(this, renderer, null, shadowCamera, geometry, depthMaterial)
        }
        fresh.push(bm)
      }
      st.triangles += tris; st.trianglesFar += trisFar
      st.draws += 2; st.shadowDraws += opts.castShadow ? 2 : 0
      st.species[name] = { trees: list.length, variants: vlist.length, trianglesNear: Math.round(tris / list.length), trianglesFar: Math.round(trisFar / list.length) }
    }

    for (const bm of meshes) { object.remove(bm); bm.dispose() }
    meshes = fresh
    for (const bm of meshes) object.add(bm)
    positions = spots.map((s) => ({ x: s.x, y: s.y ?? opts.heightAt(s.x, s.z), z: s.z }))
    st.buildMs = +(performance.now() - t0).toFixed(1)
    stats = st
  }
  await build()

  return {
    object,
    get meshes() { return meshes },
    get stats() { return stats },
    get positions() { return positions },
    get options() { return { ...opts } },
    update: windState.update,
    setWind: windState.setWind,
    async rebuild(o = {}) {
      opts = { ...opts, ...o }
      if ('wind' in o || 'windDirection' in o) windState.setWind(opts.wind, opts.windDirection)
      await build()
    },
    dispose() { for (const bm of meshes) bm.dispose(); mats.dispose() },
  }
}

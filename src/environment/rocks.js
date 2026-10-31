// Rocks: boulders, jointed blocks, slabs, shards and rounded cobbles with real form — a dense
// icosphere cut by random cleavage planes (flat fractured faces, softened edges), weathered with
// layered 3D noise and cracks, smooth normals, a flattened base that sits sunk into the ground and
// tilts with the slope. The same stratified triplanar rock shading as the terrain's cliffs. Each
// shape variant is one InstancedMesh, so hundreds of rocks cost a handful of draws.
//
//   import { createRocks } from './environment/rocks.js'
//   const rocks = createRocks({ heightAt: terrain.heightAt, mask: terrain.boulderAt,
//     area: { minX: -200, minZ: -200, maxX: 200, maxZ: 200 }, count: 120, seed: 4 })
//   scene.add(rocks.group); asset.register('rocks', rocks.group, { name: 'Rocks' })
//   createRocks({ heightAt, positions: [{ x: 3, z: -2, size: 2.5 }] })   // hand-placed hero rocks
//
// Options: count (60), area {minX,minZ,maxX,maxZ} or {x, z, radius} (default ±50 m), heightAt(x,z)
//   (default flat 0), mask(x,z) 0..1 placement probability (optional), positions [{x,z,size,variant,
//   yaw}] (skips scattering), sizeRange [min,max] m footprint width ([0.4, 3]; power law, many small),
//   seed, sink 0..0.5 of the rock's height buried (0.15), alignToGround 0..1 tilt with the slope
//   (0.65), variants: names from 'boulder' 'block' 'slab' 'shard' 'cobble' (all), detail 3..5
//   icosphere subdivision (4 = 5,120 triangles per rock), moss 0..1 (0.3), color tint, name,
//   material (share one createRockMaterial() across rebuilds/sets; not disposed by dispose()).
// Returned: group (one InstancedMesh per variant, castShadow/receiveShadow), meshes, material,
//   instances [{x,y,z,size,variant}], geometries, dispose().
// Cost: draws = variants used (≤5, +shadow); triangles = count × 5,120 at detail 4 (×1,280 at
//   detail 3: use it for > 200 rocks); build ~25 ms per variant + ~0.05 ms per rock.
// Ported from Kimi's world-building template (WebGPU/TSL) to WebGL for Edit3D.
import * as THREE from 'three'
import { createRockMaterial } from './terrain.js'

const smoothstep = (a, b, x) => { let t = (x - a) / (b - a); t = t < 0 ? 0 : t > 1 ? 1 : t; return t * t * (3 - 2 * t) }
function mulberry32(seed) {
  let a = seed >>> 0
  return () => { a = (a + 0x6D2B79F5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296 }
}

// 3D gradient noise (improved Perlin), seeded permutation
function makeNoise3(seed) {
  const r = mulberry32(seed), p = new Uint8Array(512), base = [...Array(256).keys()]
  for (let i = 255; i > 0; i--) { const j = Math.floor(r() * (i + 1)); [base[i], base[j]] = [base[j], base[i]] }
  for (let i = 0; i < 512; i++) p[i] = base[i & 255]
  const fade = (t) => t * t * t * (t * (t * 6 - 15) + 10)
  const grad = (h, x, y, z) => { h &= 15; const u = h < 8 ? x : y, v = h < 4 ? y : h === 12 || h === 14 ? x : z; return ((h & 1) ? -u : u) + ((h & 2) ? -v : v) }
  return (x, y, z) => {
    const X = Math.floor(x), Y = Math.floor(y), Z = Math.floor(z)
    x -= X; y -= Y; z -= Z
    const xi = X & 255, yi = Y & 255, zi = Z & 255, u = fade(x), v = fade(y), w = fade(z)
    const A = p[xi] + yi, AA = p[A] + zi, AB = p[A + 1] + zi, B = p[xi + 1] + yi, BA = p[B] + zi, BB = p[B + 1] + zi
    const l = (a, b, t) => a + (b - a) * t
    return l(l(l(grad(p[AA], x, y, z), grad(p[BA], x - 1, y, z), u), l(grad(p[AB], x, y - 1, z), grad(p[BB], x - 1, y - 1, z), u), v),
      l(l(grad(p[AA + 1], x, y, z - 1), grad(p[BA + 1], x - 1, y, z - 1), u), l(grad(p[AB + 1], x, y - 1, z - 1), grad(p[BB + 1], x - 1, y - 1, z - 1), u), v), w)
  }
}

// indexed icosphere (shared vertices -> smooth normals across the whole rock)
function icosphere(detail) {
  const t = (1 + Math.sqrt(5)) / 2
  let verts = [[-1, t, 0], [1, t, 0], [-1, -t, 0], [1, -t, 0], [0, -1, t], [0, 1, t], [0, -1, -t], [0, 1, -t], [t, 0, -1], [t, 0, 1], [-t, 0, -1], [-t, 0, 1]]
    .map(([x, y, z]) => { const l = Math.hypot(x, y, z); return [x / l, y / l, z / l] })
  let faces = [[0, 11, 5], [0, 5, 1], [0, 1, 7], [0, 7, 10], [0, 10, 11], [1, 5, 9], [5, 11, 4], [11, 10, 2], [10, 7, 6], [7, 1, 8],
    [3, 9, 4], [3, 4, 2], [3, 2, 6], [3, 6, 8], [3, 8, 9], [4, 9, 5], [2, 4, 11], [6, 2, 10], [8, 6, 7], [9, 8, 1]]
  for (let d = 0; d < detail; d++) {
    const cache = new Map(), next = []
    const mid = (a, b) => {
      const k = a < b ? a * 65536 + b : b * 65536 + a
      let i = cache.get(k)
      if (i === undefined) { const A = verts[a], B = verts[b], x = A[0] + B[0], y = A[1] + B[1], z = A[2] + B[2], l = Math.hypot(x, y, z); i = verts.length; verts.push([x / l, y / l, z / l]); cache.set(k, i) }
      return i
    }
    for (const [a, b, c] of faces) { const ab = mid(a, b), bc = mid(b, c), ca = mid(c, a); next.push([a, ab, ca], [b, bc, ab], [c, ca, bc], [ab, bc, ca]) }
    faces = next
  }
  return { verts, faces }
}

// shape recipes: ellipsoid proportions, cleavage planes (count, distance range), edge softness,
// weathering amplitudes. Footprint is normalised to 1 m; height follows the proportions.
const VARIANTS = {
  boulder: { sx: 1.0, sy: 0.74, sz: 0.86, planes: 6, d: [0.74, 0.9], k: 0.07, lump: 0.10, mid: 0.035, crack: 0.035, weight: 0.32 },
  block: { sx: 1.0, sy: 0.82, sz: 0.8, planes: 9, d: [0.56, 0.7], k: 0.028, lump: 0.05, mid: 0.025, crack: 0.04, weight: 0.24 },
  slab: { sx: 1.25, sy: 0.42, sz: 0.95, planes: 7, d: [0.6, 0.78], k: 0.032, lump: 0.05, mid: 0.022, crack: 0.03, top: 0.34, weight: 0.18 },
  shard: { sx: 0.62, sy: 1.2, sz: 0.55, planes: 8, d: [0.52, 0.72], k: 0.024, lump: 0.05, mid: 0.025, crack: 0.035, weight: 0.1 },
  cobble: { sx: 1.0, sy: 0.58, sz: 0.78, planes: 3, d: [0.86, 0.96], k: 0.14, lump: 0.05, mid: 0.012, crack: 0.0, weight: 0.16 },
}

function buildRockGeometry(kind, seed, detail) {
  const V = VARIANTS[kind], r = mulberry32(seed * 7919 + 17), noise = makeNoise3(seed * 31 + 5)
  const { verts, faces } = icosphere(detail)
  // cleavage planes: normals spread over the sphere (none pointing straight down: the base is cut flat)
  const planes = []
  for (let i = 0; i < V.planes; i++) {
    let x, y, z, l
    do { x = r() * 2 - 1; y = r() * 2 - 1; z = r() * 2 - 1; l = Math.hypot(x, y, z) } while (l > 1 || l < 0.2 || y / l < -0.55)
    planes.push([x / l, y / l, z / l, V.d[0] + r() * (V.d[1] - V.d[0])])
  }
  if (V.top) planes.push([r() * 0.16 - 0.08, 1, r() * 0.16 - 0.08, V.top])
  const off = [r() * 50, r() * 50, r() * 50]
  const pos = new Float32Array(verts.length * 3)
  let minY = Infinity, maxY = -Infinity
  for (let i = 0; i < verts.length; i++) {
    const [x, y, z] = verts[i]
    // soft-min of the sphere and the planes' ray distances: flat fractured faces, rounded arrises
    let acc = Math.exp(-1 / V.k)
    for (const [nx, ny, nz, d] of planes) { const c = nx * x + ny * y + nz * z; if (c > 1e-3) acc += Math.exp(-(d / c) / V.k) }
    let rad = -V.k * Math.log(acc)
    // weathering: broad lumps, mid-scale pitting and a few cracks (ridged noise, cut inward)
    const px = x * 1.3 + off[0], py = y * 1.3 + off[1], pz = z * 1.3 + off[2]
    const lump = noise(px, py, pz) + noise(px * 2.1, py * 2.1, pz * 2.1) * 0.5
    const mid = noise(px * 5.3, py * 5.3, pz * 5.3) + noise(px * 11, py * 11, pz * 11) * 0.45
    const cr = 1 - Math.abs(noise(px * 2.6 + 9, py * 2.6, pz * 2.6))
    rad *= 1 + V.lump * lump + V.mid * mid - V.crack * Math.pow(cr, 14)
    const X = x * rad * V.sx, Y = y * rad * V.sy, Z = z * rad * V.sz
    pos[i * 3] = X; pos[i * 3 + 1] = Y; pos[i * 3 + 2] = Z
    if (Y < minY) minY = Y; if (Y > maxY) maxY = Y
  }
  // flattened base: a smooth max against a cut plane a fifth of the way up, then sit it on y = 0
  const b = minY + (maxY - minY) * 0.2, kb = (maxY - minY) * 0.06
  let mnX = Infinity, mxX = -Infinity, mnZ = Infinity, mxZ = -Infinity, mnY = Infinity
  for (let i = 0; i < verts.length; i++) {
    const y = pos[i * 3 + 1], d = y - b
    pos[i * 3 + 1] = 0.5 * (y + b + Math.sqrt(d * d + kb * kb))
    if (pos[i * 3 + 1] < mnY) mnY = pos[i * 3 + 1]
  }
  for (let i = 0; i < verts.length; i++) {
    const x = pos[i * 3], z = pos[i * 3 + 2]
    if (x < mnX) mnX = x; if (x > mxX) mxX = x; if (z < mnZ) mnZ = z; if (z > mxZ) mxZ = z
  }
  const cx = (mnX + mxX) / 2, cz = (mnZ + mxZ) / 2, s = 1 / Math.max(mxX - mnX, mxZ - mnZ)
  let top = 0
  for (let i = 0; i < verts.length; i++) {
    pos[i * 3] = (pos[i * 3] - cx) * s; pos[i * 3 + 1] = (pos[i * 3 + 1] - mnY) * s; pos[i * 3 + 2] = (pos[i * 3 + 2] - cz) * s
    if (pos[i * 3 + 1] > top) top = pos[i * 3 + 1]
  }
  const index = new (verts.length > 65535 ? Uint32Array : Uint16Array)(faces.length * 3)
  faces.forEach(([a, b2, c], i) => { index[i * 3] = a; index[i * 3 + 1] = b2; index[i * 3 + 2] = c })
  const g = new THREE.BufferGeometry()
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3))
  g.setIndex(new THREE.BufferAttribute(index, 1))
  g.computeVertexNormals()
  g.computeBoundingBox(); g.computeBoundingSphere()
  g.userData.height = top   // height per metre of footprint
  g.name = `rock-${kind}`
  return g
}

export function createRocks(opts = {}) {
  const t0 = performance.now()
  const {
    count = 60, heightAt = () => 0, mask, positions, sizeRange = [0.4, 3], seed = 1, sink = 0.15, alignToGround = 0.65,
    detail = 4, moss = 0.3, color, name = 'Rocks', material: sharedMaterial,
  } = opts
  const kinds = (opts.variants ?? Object.keys(VARIANTS)).filter((k) => VARIANTS[k])
  const area = opts.area ?? { minX: -50, minZ: -50, maxX: 50, maxZ: 50 }
  const rect = area.radius !== undefined
    ? { minX: area.x - area.radius, maxX: area.x + area.radius, minZ: area.z - area.radius, maxZ: area.z + area.radius, cx: area.x, cz: area.z, r: area.radius }
    : area
  const rand = mulberry32(seed * 2654435761 + 11)
  const geometries = kinds.map((k, i) => buildRockGeometry(k, seed * 13 + i * 101 + 3, THREE.MathUtils.clamp(Math.round(detail), 2, 5)))
  const material = sharedMaterial ?? createRockMaterial({ name: `${name} · Stone`, moss, color })

  // ---- choose sites
  const pickKind = (size) => {
    // big rocks are blocks, boulders and slabs; the small ones are mostly rounded cobbles
    const small = smoothstep(1.2, 0.5, size)
    let total = 0
    const w = kinds.map((k) => { const v = VARIANTS[k].weight * (k === 'cobble' ? 0.4 + 3 * small : k === 'shard' ? 1 - small : 1); total += v; return v })
    let u = rand() * total
    for (let i = 0; i < kinds.length; i++) { u -= w[i]; if (u <= 0) return i }
    return kinds.length - 1
  }
  const sites = []
  if (positions) {
    for (const p of positions) {
      const size = p.size ?? 1.5
      const vi = p.variant !== undefined ? Math.max(0, kinds.indexOf(p.variant)) : pickKind(size)
      sites.push({ x: p.x, z: p.z, size, vi, yaw: p.yaw ?? rand() * Math.PI * 2 })
    }
  } else {
    const [s0, s1] = sizeRange, placed = []
    for (let tries = 0; sites.length < count && tries < count * 80; tries++) {
      const x = rect.minX + rand() * (rect.maxX - rect.minX), z = rect.minZ + rand() * (rect.maxZ - rect.minZ)
      if (rect.r !== undefined && Math.hypot(x - rect.cx, z - rect.cz) > rect.r) continue
      if (mask) { const m = mask(x, z); if (!(m > 0) || rand() > m) continue }
      const size = s0 * Math.pow(s1 / s0, Math.pow(rand(), 2.2))
      let ok = true
      for (const q of placed) { const lim = (size + q.size) * 0.5; if ((q.x - x) ** 2 + (q.z - z) ** 2 < lim * lim) { ok = false; break } }
      if (!ok) continue
      const site = { x, z, size, vi: pickKind(size), yaw: rand() * Math.PI * 2 }
      placed.push(site); sites.push(site)
    }
  }

  // ---- matrices: sit on the ground, tilt with it, bury the base
  const up = new THREE.Vector3(0, 1, 0), n = new THREE.Vector3(), q = new THREE.Quaternion(), qy = new THREE.Quaternion(), qt = new THREE.Quaternion()
  const m4 = new THREE.Matrix4(), sc = new THREE.Vector3(), ps = new THREE.Vector3()
  const byKind = kinds.map(() => [])
  const instances = []
  for (const s of sites) {
    const g = geometries[s.vi], hRock = g.userData.height * s.size, e = Math.max(0.25, s.size * 0.5)
    const hc = heightAt(s.x, s.z)
    n.set(heightAt(s.x - e, s.z) - heightAt(s.x + e, s.z), 2 * e, heightAt(s.x, s.z - e) - heightAt(s.x, s.z + e)).normalize()
    let hmin = hc
    for (let a = 0; a < 6; a++) { const ang = a * Math.PI / 3 + s.yaw; hmin = Math.min(hmin, heightAt(s.x + Math.cos(ang) * s.size * 0.42, s.z + Math.sin(ang) * s.size * 0.42)) }
    const tilt = n.clone().lerp(up, 1 - alignToGround).normalize()
    qt.setFromUnitVectors(up, tilt)
    // a little random lean so a field of rocks is not all parallel to the ground
    const lean = new THREE.Euler((rand() - 0.5) * 0.18, 0, (rand() - 0.5) * 0.18)
    qy.setFromAxisAngle(up, s.yaw)
    q.copy(qt).multiply(new THREE.Quaternion().setFromEuler(lean)).multiply(qy)
    const y = hc - (1 - alignToGround) * (hc - hmin) - sink * hRock - 0.02 * s.size
    const jit = 0.88 + rand() * 0.24
    sc.set(s.size * jit, s.size * (0.85 + rand() * 0.3), s.size * (2 - jit))
    ps.set(s.x, y, s.z)
    m4.compose(ps, q, sc)
    byKind[s.vi].push(m4.clone())
    instances.push({ x: s.x, y, z: s.z, size: s.size, variant: kinds[s.vi] })
  }

  const group = new THREE.Group()
  group.name = name
  const meshes = []
  const tint = new THREE.Color()
  byKind.forEach((mats, vi) => {
    // every variant gets its mesh even when empty, so the mesh/material set is stable across rebuilds
    const im = new THREE.InstancedMesh(geometries[vi], material, Math.max(1, mats.length))
    im.count = mats.length
    im.name = `${name} · ${kinds[vi]}`
    mats.forEach((m, i) => {
      im.setMatrixAt(i, m)
      const v = 0.86 + rand() * 0.22, warm = (rand() - 0.5) * 0.06
      im.setColorAt(i, tint.setRGB(v * (1 + warm), v, v * (1 - warm)))
    })
    im.instanceMatrix.needsUpdate = true
    if (im.instanceColor) im.instanceColor.needsUpdate = true
    im.castShadow = true; im.receiveShadow = true
    im.computeBoundingBox(); im.computeBoundingSphere()
    group.add(im); meshes.push(im)
  })
  const buildMs = Math.round(performance.now() - t0)
  const triangles = meshes.reduce((a, m) => a + m.count * m.geometry.index.count / 3, 0), draws = meshes.filter((m) => m.count > 0).length
  return {
    group, object: group, meshes, material, instances, geometries,
    stats: { rocks: instances.length, draws, triangles, buildMs },
    dispose() { for (const g of geometries) g.dispose(); if (!sharedMaterial) material.dispose(); for (const m of meshes) m.dispose() },
  }
}

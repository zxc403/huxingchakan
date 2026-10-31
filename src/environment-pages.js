import * as THREE from 'three'
import { MeshStandardNodeMaterial, PMREMGenerator as NodePMREMGenerator } from 'three/webgpu'
import { positionLocal, time, instanceIndex, vec3 } from 'three/tsl'
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js'
import { createForest } from './environment/trees.js'
import { createGrass } from './environment/grass.js'
import { assetUrl } from './building.js'

function skyTexture(hour) {
  const canvas = document.createElement('canvas'); canvas.width = 1024; canvas.height = 512
  const ctx = canvas.getContext('2d')
  const daylight = Math.max(0, Math.sin((hour - 6) / 12 * Math.PI))
  const dusk = Math.exp(-Math.pow((hour - 18) / 1.6, 2))
  const gradient = ctx.createLinearGradient(0, 0, 0, 340)
  const blend = (day, night) => Math.round(night + (day - night) * Math.max(0.12, daylight))
  gradient.addColorStop(0, `rgb(${blend(87,6)},${blend(151,13)},${blend(207,32)})`)
  gradient.addColorStop(0.7, `rgb(${blend(208 + dusk * 25,14)},${blend(224 - dusk * 70,22)},${blend(224 - dusk * 85,46)})`)
  gradient.addColorStop(1, `rgb(${blend(235,30)},${blend(232 - dusk * 90,29)},${blend(210 - dusk * 95,50)})`)
  ctx.fillStyle = gradient; ctx.fillRect(0, 0, 1024, 340)
  ctx.fillStyle = `rgb(${blend(92,10)},${blend(103,15)},${blend(77,20)})`; ctx.fillRect(0, 340, 1024, 172)
  const sunX = ((hour - 6) / 12) * 1024, sunY = 270 - daylight * 230
  const halo = ctx.createRadialGradient(sunX, sunY, 0, sunX, sunY, 90)
  halo.addColorStop(0, 'rgba(255,244,210,.95)'); halo.addColorStop(0.05, 'rgba(255,235,190,.75)'); halo.addColorStop(1, 'rgba(255,214,165,0)')
  ctx.fillStyle = halo; ctx.fillRect(sunX - 90, sunY - 90, 180, 180)
  let seed = 51
  const random = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296 }
  for (let i = 0; i < 32; i++) {
    const x = random() * 1024, y = 70 + random() * 170, w = 30 + random() * 95
    ctx.fillStyle = `rgba(245,244,230,${0.025 + random() * 0.065})`
    ctx.beginPath(); ctx.ellipse(x, y, w, 5 + random() * 10, 0, 0, Math.PI * 2); ctx.fill()
  }
  const texture = new THREE.CanvasTexture(canvas)
  texture.mapping = THREE.EquirectangularReflectionMapping
  texture.colorSpace = THREE.SRGBColorSpace
  texture.magFilter = texture.minFilter = THREE.LinearFilter
  return texture
}

function nodeGrass() {
  const geometry = new THREE.BufferGeometry()
  geometry.setAttribute('position', new THREE.Float32BufferAttribute([-0.025,0,0, 0.025,0,0, -0.018,0.09,0.007, 0.018,0.09,0.007, 0,0.19,0.025], 3))
  geometry.setIndex([0,1,2,1,3,2,2,3,4]); geometry.computeVertexNormals()
  const count = 16500
  const material = new MeshStandardNodeMaterial({ name: '草坪 · 风动草叶', color: '#687d3e', roughness: 0.95, side: THREE.DoubleSide })
  material.positionNode = positionLocal.add(vec3(time.mul(1.4).add(instanceIndex.toFloat().mul(0.37)).sin().mul(positionLocal.y.pow(1.5)).mul(0.52), 0, 0))
  const mesh = new THREE.InstancedMesh(geometry, material, count)
  mesh.name = '草坪 · 实例草叶'
  const transform = new THREE.Object3D()
  let seed = 51, actual = 0
  const random = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296 }
  const excluded = (x, z) => (Math.abs(x) < 11 && Math.abs(z) < 9.5) || (Math.abs(z - 12) < 1.6 && Math.abs(x) < 24) || (Math.abs(x - 13.5) < 1.6 && Math.abs(z) < 19) || (Math.abs(Math.abs(x) - 9.8) < 0.8 && Math.abs(z) < 7)
  for (let i = 0; i < count; i++) {
    let x, z
    do { x = (random() - 0.5) * 69; z = (random() - 0.5) * 69 } while (excluded(x, z))
    const height = 0.55 + random() * 0.85
    transform.position.set(x, -0.065, z); transform.rotation.set(0, random() * Math.PI * 2, (random() - 0.5) * 0.12)
    transform.scale.set(0.8 + random() * 0.6, height, 1); transform.updateMatrix()
    mesh.setMatrixAt(actual++, transform.matrix)
    mesh.setColorAt(i, new THREE.Color().setHSL(0.19 + random() * 0.045, 0.28 + random() * 0.18, 0.29 + random() * 0.13))
  }
  mesh.count = actual
  mesh.receiveShadow = true; mesh.castShadow = false
  return { object: mesh, update() {}, dispose() { geometry.dispose(); material.dispose(); mesh.dispose() } }
}

export async function createPageEnvironment(scene, renderer, { base = '/', webgpu = false, hour = 15.7 } = {}) {
  const room = new RoomEnvironment()
  const PMREMGenerator = webgpu ? NodePMREMGenerator : THREE.PMREMGenerator
  const pmrem = new PMREMGenerator(renderer)
  const environment = pmrem.fromScene(room, 0.05)
  scene.environment = environment.texture
  scene.environmentIntensity = 0.72
  room.dispose(); pmrem.dispose()
  const sun = new THREE.DirectionalLight('#fff1d4', 3.0)
  sun.name = '太阳 · 软阴影'
  sun.position.set(-22, 36, 20); sun.target.position.set(0, 7, 0)
  sun.castShadow = true
  sun.shadow.mapSize.set(2048, 2048)
  Object.assign(sun.shadow.camera, { left: -24, right: 24, top: 27, bottom: -22, near: 1, far: 110 })
  sun.shadow.bias = -0.00015; sun.shadow.normalBias = 0.028; sun.shadow.radius = 3
  scene.add(sun, sun.target, new THREE.HemisphereLight('#d5e5f4', '#5e664d', 1.0))
  scene.fog = new THREE.Fog('#c2d0c8', 60, 150)
  let sky = skyTexture(hour); scene.background = sky
  const forest = await createForest({
    points: [[-13,7],[-14,-7],[13,-9],[17,7],[-18,-14],[7,-14],[-23,5],[23,-3],[-18,18],[20,19]],
    heightAt: () => -0.07, species: 'ash', variants: 3, seed: 51, wind: 0.26,
    lodDistance: 38, castShadow: false, textureBase: assetUrl(base, 'environment/'),
  })
  if (webgpu) {
    for (const mesh of forest.meshes) {
      const old = mesh.material
      const material = new MeshStandardNodeMaterial({ name: old.name.includes('trunk') ? '庭院乔木 · 树皮' : '庭院乔木 · 叶片', color: old.map ? '#d6dea1' : '#766148', map: old.map || null, alphaTest: old.alphaTest, side: old.side, roughness: old.roughness })
      mesh.material = material
      mesh.customDepthMaterial = null
    }
  }
  scene.add(forest.object)
  const grass = webgpu ? nodeGrass() : createGrass({
    height: 0.18, density: 0.65, radius: 43, dryness: 0.13, y: -0.065, seed: 51,
    bounds: { minX: -36, minZ: -36, maxX: 36, maxZ: 36 },
    exclude: [{ rect: [0,0,22,19], feather: 0.12 },{ rect: [0,12,48,3], feather: 0.15 },{ rect: [13.5,0,3,38], feather: 0.15 },{ rect: [-9.8,0,1.2,13.2], feather: 0.1 },{ rect: [9.8,0,1.2,13.2], feather: 0.1 }],
  })
  scene.add(grass.object)
  return {
    forest, grass,
    sample(t) { forest.update(t); grass.update(t) },
    setHour(value) {
      const elevation = Math.max(0.07, Math.sin((value - 6) / 12 * Math.PI))
      const angle = (value - 6) / 12 * Math.PI
      sun.position.set(Math.cos(angle) * 40, 10 + elevation * 38, Math.sin(angle) * 28)
      sun.intensity = 0.25 + elevation * 3.0
      sun.color.set(value > 17 ? '#ffcf98' : value < 8 ? '#ffddb5' : '#fff3dc')
      sky.dispose(); sky = skyTexture(value); scene.background = sky
    },
    dispose() { forest.dispose(); grass.dispose(); environment.dispose(); sky.dispose() },
  }
}

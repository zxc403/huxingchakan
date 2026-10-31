import * as THREE from 'three'
import { Octree } from 'three/addons/math/Octree.js'

export const FLOOR_Y = { 1: 0, 2: 3.6, 3: 6.6, 4: 9.6, 5: 12.6, 6: 15.6 }
export const SPAWNS = {
  1: [0, 0.10, 10.4],
  2: [-1.25, 3.72, 6.55],
  3: [-1.25, 6.72, 6.55],
  4: [-1.25, 9.72, 6.55],
  5: [-1.25, 12.72, 6.55],
  6: [-1.25, 15.72, 6.55],
}
export const assetUrl = (base, file) => `${base || '/'}${base?.endsWith('/') ? '' : '/'}${file.replace(/^\//, '')}`

// asset.loadModel in Edit3D; GLTFLoader in the standalone renderer. Both return the same shape.
export async function loadBuilding(loader, base = '/', { modelFile = 'models/model.glb' } = {}) {
  const [building, collision, avatar] = await Promise.all([
    loader(assetUrl(base, modelFile)),
    loader(assetUrl(base, 'models/collision.glb')),
    loader(assetUrl(base, 'models/character.glb')),
  ])
  const model = building.object
  model.name = '3栋51号住宅'
  const floorObjects = new Map()
  const editable = []
  for (const child of model.children) {
    const match = child.name.match(/^(?:BATCH|STATIC|EDIT)_F(\d{2})_/)
    if (match) {
      const floor = Number(match[1])
      if (!floorObjects.has(floor)) floorObjects.set(floor, [])
      floorObjects.get(floor).push(child)
    }
    if (/^EDIT_F0[56]_/.test(child.name)) editable.push(child)
  }
  const materials = new Set()
  model.traverse((object) => {
    if (!object.isMesh) return
    object.receiveShadow = true
    object.castShadow = !object.material?.transparent
    for (const material of [].concat(object.material || [])) {
      materials.add(material)
      if (/玻璃|Glass/i.test(material.name)) {
        // Stable, inexpensive architectural glazing. A full scene transmission pass per window
        // would cost far more than the subtle reflection it adds on a phone.
        material.transmission = 0
        material.transparent = true
        material.opacity = 0.30
        material.depthWrite = false
        material.roughness = 0.10
        material.metalness = 0.12
      }
      if (material.map) material.map.anisotropy = 8
      if (material.normalMap) material.normalMap.anisotropy = 4
    }
  })
  let currentFloor = 0
  function setFloor(floor) {
    currentFloor = Number(floor) || 0
    for (const [number, objects] of floorObjects) {
      const visible = currentFloor === 0 || currentFloor === number
      for (const object of objects) object.visible = visible
    }
    model.traverse((object) => {
      // Hidden floor roots still cast no draw calls, while the visible shell, roof and
      // current-floor ceiling must block direct sun instead of leaking daylight indoors.
      if (object.isMesh) object.castShadow = !object.material?.transparent
    })
  }
  function createOctree() {
    collision.object.updateMatrixWorld(true)
    return new Octree().fromGraphNode(collision.object)
  }
  return { model, collision: collision.object, avatar: avatar.object, animations: avatar.animations || [], editable, materials, setFloor, createOctree, getFloor: () => currentFloor }
}

export function addBuildingLights(scene) {
  const group = new THREE.Group()
  group.name = '室内灯光'
  const lights = []
  for (let floor = 1; floor <= 6; floor++) {
    const warm = floor === 6
    for (const [x, z, power] of [[-1.3, 5.1, 18], [3.0, 5.1, 18], [-3.0, 0.4, 12], [4.0, 0.4, 12]]) {
      const light = new THREE.PointLight(warm ? 0xffd29a : 0xf0f3ff, power, 8.5, 2)
      light.name = `${floor}F ${warm ? '3000K暖光' : '中性筒灯'}`
      light.position.set(x, FLOOR_Y[floor] + (floor === 1 ? 3.15 : 2.6), z)
      light.userData = { floor, power }
      group.add(light)
      lights.push(light)
    }
  }
  scene.add(group)
  let intensity = 1
  return {
    group,
    setFloor(floor) {
      for (const light of lights) light.intensity = (!floor || light.userData.floor === floor) ? light.userData.power * intensity : 0
      scene.environmentIntensity = floor ? 0.35 : 0.72
    },
    setIntensity(value) { intensity = value; for (const light of lights) if (light.intensity > 0) light.intensity = light.userData.power * value },
    get intensity() { return intensity },
  }
}

export function createAvatar(model, clips) {
  model.name = '漫游人物'
  const mixer = new THREE.AnimationMixer(model)
  const actions = {}
  for (const clip of clips) {
    const action = mixer.clipAction(clip)
    actions[clip.name.toLowerCase()] = action
    if (clip.name === 'jump') { action.setLoop(THREE.LoopOnce); action.clampWhenFinished = true; action.timeScale = 1.35 }
  }
  let active = null
  function play(name, fade = 0.20) {
    const next = actions[name] || actions.idle
    if (!next || active === next) return
    next.reset().play()
    if (active) next.crossFadeFrom(active, fade, false)
    active = next
  }
  model.traverse((object) => { if (object.isMesh) { object.castShadow = true; object.receiveShadow = true; object.frustumCulled = false } })
  play('idle', 0)
  return { object: model, mixer, actions, play, get current() { return active?.getClip().name }, dispose() { mixer.stopAllAction(); mixer.uncacheRoot(model) } }
}

export function floorAt(y) {
  if (y < 2.0) return 1
  return THREE.MathUtils.clamp(Math.round((y - 3.6) / 3) + 2, 2, 6)
}

export function registerFurniture(asset, editable) {
  const registered = []
  for (const object of editable) {
    const match = object.name.match(/^EDIT_F(05|06)_(LeftMaster|RightMaster|Left|Right)_?(ModernSofa|Sofa|ModernBed|Bed)$/)
    if (!match) continue
    const [, floor, room, kind] = match
    const id = `f${floor}-${room.toLowerCase()}-${kind.toLowerCase()}`
    const label = `${Number(floor)}F ${room.startsWith('Left') ? '左户' : '右户'}${kind.toLowerCase().includes('sofa') ? '客厅沙发' : '主卧床'}`
    asset.register(id, object, { name: label, parent: 'building' })
    registered.push(id)
  }
  return registered
}

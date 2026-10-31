import * as THREE from 'three'
import { enableToneMapping } from './environment/tonemap.js'
import { createOutdoor } from './environment-edit.js'
import { loadBuilding, addBuildingLights, createAvatar, registerFurniture } from './building.js'
import { createRoaming } from './controls.js'
import { bindParams, excludeFromFraming, framingReport } from './kit/edit3d.js'

export async function createBuildingScene({ asset, mode = 'tour' }) {
  enableToneMapping({ curve: 'aces', exposure: 1.0 })
  const scene = new THREE.Scene()
  scene.name = mode === 'tour' ? '3栋51号 · 建筑巡场' : '3栋51号 · 自由漫游'
  const camera = new THREE.PerspectiveCamera(46, 1, 0.07, 260)
  camera.name = mode === 'tour' ? '巡场主相机' : '漫游主相机'
  camera.position.set(24, 22, 30)
  camera.lookAt(0, 8.2, 0)
  const building = await loadBuilding((url) => asset.loadModel(url))
  excludeFromFraming(...building.model.children.filter((object) => /^(?:BATCH|STATIC)_SITE_/.test(object.name)))
  scene.add(building.model, camera)
  const lighting = addBuildingLights(scene)
  const settings = { hour: 15.7, interior: 0.85, displayFloor: 'all', walkSpeed: 2.6, runSpeed: 5.0, cameraDistance: 3.4 }
  const outdoor = await createOutdoor(scene, { hour: settings.hour })
  const furniture = registerFurniture(asset, building.editable)
  asset.register('building', building.model, { name: '3栋51号 · 六层住宅' })
  asset.register('camera', camera, { name: mode === 'tour' ? '连续建筑巡场相机' : '第三人称漫游相机' })
  asset.register('planting', outdoor.forest.object, { name: '庭院植被' })
  const subscriptions = []
  subscriptions.push(bindParams(asset, 'atmosphere', settings, {
    hour: { label: '太阳时段', type: 'number', min: 6, max: 22, step: 0.1 },
    interior: { label: '室内灯光强度', type: 'number', min: 0, max: 3, step: 0.05 },
  }, (values) => { outdoor.setHour(values.hour); lighting.setIntensity(values.interior) }, { name: '光照与时段', objectId: 'building' }))
  subscriptions.push(bindParams(asset, 'display', settings, {
    displayFloor: { label: '室内细节楼层', type: 'enum', options: [
      { label: '全部楼层（巡场）', value: 'all' }, ...[1,2,3,4,5,6].map((n) => ({ label: `${n}F`, value: String(n) })),
    ] },
  }, (values) => {
    const floor = values.displayFloor === 'all' ? 0 : Number(values.displayFloor)
    building.setFloor(floor); lighting.setFloor(floor)
  }, { name: '楼层显示', objectId: 'building' }))

  let avatar = null
  if (mode === 'walk') {
    avatar = createAvatar(building.avatar, building.animations)
    avatar.object.position.set(0, -0.04, 10.4)
    avatar.object.rotation.y = Math.PI
    scene.add(avatar.object)
    asset.register('avatar', avatar.object, { name: '第三人称漫游人物' })
    subscriptions.push(bindParams(asset, 'movement', settings, {
      walkSpeed: { label: '行走速度（米/秒）', type: 'number', min: 0.6, max: 6, step: 0.1 },
      runSpeed: { label: '奔跑速度（米/秒）', type: 'number', min: 1.5, max: 10, step: 0.1 },
      cameraDistance: { label: '第三人称镜头距离（米）', type: 'number', min: 1.4, max: 7, step: 0.1 },
    }, () => {}, { name: '人物与镜头', objectId: 'avatar' }))
    asset.registerText('walk-hint', {
      name: '漫游提示', text: '进入 Play 自由漫游 · 六层空间可传送，也可走楼梯',
      position: [0.5, 0.055], style: { font: '24px sans-serif', color: '#f4eee3', strokeColor: '#17271f', strokeWidth: 3 },
    })
  } else {
    building.setFloor(0); lighting.setFloor(0)
    const shots = [
      { id: 'establishing', duration: 8, keys: [
        [[24, 22, 30], [0, 8.2, 0]], [[18, 16, 26], [0, 8.0, 0]], [[12, 8.5, 20], [0, 5.4, 0]],
      ] },
      { id: 'lobby', duration: 7, keys: [
        [[0, 1.8, 10.5], [0, 1.4, 0]], [[0, 1.7, 6.5], [-2.3, 1.4, 2.6]], [[-0.5, 1.65, 3.3], [-3.3, 1.15, 3.1]],
      ] },
      { id: 'modern', duration: 9, keys: [
        [[-1.25, 14.30, 7.05], [-0.9, 13.65, 4.2]], [[-2.55, 14.15, 6.75], [-0.6, 13.55, 4.1]], [[0.10, 14.10, 6.65], [-1.4, 13.55, 4.2]],
      ] },
      { id: 'american', duration: 10, keys: [
        [[-1.25, 17.30, 7.05], [-0.9, 16.50, 4.2]], [[-2.55, 17.25, 6.75], [-0.6, 16.25, 4.1]], [[0.10, 17.20, 6.65], [-1.4, 16.30, 4.2]],
      ] },
      { id: 'dining', duration: 8, keys: [
        [[-4.65, 17.25, 2.20], [-2.8, 16.75, -0.15]], [[-4.45, 17.20, 2.45], [-2.75, 16.55, -0.10]], [[-4.05, 17.10, 2.65], [-2.55, 16.45, 0.0]],
      ] },
    ]
    for (const shot of shots) {
      const keyframes = []
      for (let segment = 0; segment < shot.keys.length - 1; segment++) {
        const steps = 8
        for (let step = 0; step < steps; step++) {
          const t = step / steps, time = (segment + t) * shot.duration / (shot.keys.length - 1)
          const smooth = t * t * (3 - 2 * t)
          keyframes.push({ time, position: shot.keys[segment][0].map((n, i) => THREE.MathUtils.lerp(n, shot.keys[segment + 1][0][i], smooth)), lookAt: shot.keys[segment][1].map((n, i) => THREE.MathUtils.lerp(n, shot.keys[segment + 1][1][i], smooth)) })
        }
      }
      keyframes.push({ time: shot.duration, position: shot.keys.at(-1)[0], lookAt: shot.keys.at(-1)[1] })
      asset.registerShot(shot.id, { camera: 'camera', duration: shot.duration, keyframes })
    }
    asset.registerTrack('shots', { name: '建筑巡场', clips: shots.map((shot) => ({ shotId: shot.id })) })
    asset.registerAnimation('courtyard-wind', {
      name: '庭院风、天空与巡场楼层', objectId: 'planting', duration: 120,
      sample(time) {
        outdoor.sample(time)
        if (settings.displayFloor !== 'all') return
        const floor = time < 8 ? 0 : time < 15 ? 1 : time < 24 ? 5 : 6
        if (building.getFloor() !== floor) { building.setFloor(floor); lighting.setFloor(floor) }
      },
    })
  }
  const framing = framingReport(scene, building.model)
  const handle = { scene, camera, building, lighting, outdoor, settings, furniture, framing }
  window.__building51Scenes ||= {}
  window.__building51Scenes[mode] = handle
  return {
    scene, camera,
    ...(mode === 'walk' ? { play(context) {
      let time = 0
      const game = createRoaming(context, scene, { camera, building, lighting, settings, embedded: true, initialFloor: 1 })
      return { update(dt) { time += dt; outdoor.sample(time); game.update(dt) }, dispose() { game.dispose() } }
    } } : {}),
    dispose() {
      for (const unsubscribe of subscriptions) unsubscribe()
      outdoor.dispose()
      avatar?.dispose()
      delete window.__building51Scenes?.[mode]
    },
  }
}

export function createScene(options) { return createBuildingScene({ ...options, mode: 'tour' }) }

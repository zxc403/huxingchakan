import * as THREE from 'three'
import { createSky } from './environment/sky.js'
import { createForest } from './environment/trees.js'
import { createGrass } from './environment/grass.js'
import { excludeFromFraming } from './kit/edit3d.js'
import { assetUrl } from './building.js'

export async function createOutdoor(scene, { base = '/', hour = 15.7, wind = 0.26 } = {}) {
  const sun = new THREE.DirectionalLight()
  sun.name = '太阳 · 午后柔光'
  sun.castShadow = true
  sun.shadow.mapSize.set(2048, 2048)
  Object.assign(sun.shadow.camera, { left: -25, right: 25, top: 28, bottom: -22, near: 1, far: 110 })
  sun.shadow.bias = -0.00015
  sun.shadow.normalBias = 0.025
  sun.shadow.radius = 3
  sun.target.position.set(0, 7, 0)
  scene.add(sun, sun.target)
  const sky = createSky({ hour, clouds: 0.28, haze: 1.5, aerialScale: 2.2, groundColor: '#59634a' })
  sky.applyTo(scene, { sun })
  const forest = await createForest({
    points: [[-13, 7], [-14, -7], [13, -9], [17, 7], [-18, -14], [7, -14], [-23, 5], [23, -3], [-18, 18], [20, 19]],
    heightAt: () => -0.07, species: 'ash', variants: 3, seed: 51, wind,
    lodDistance: 38, castShadow: false, textureBase: assetUrl(base, 'environment/'),
  })
  forest.object.name = '庭院乔木 · 风动梣树'
  const grass = createGrass({
    height: 0.18, density: 0.65, radius: 43, dryness: 0.13, y: -0.065, seed: 51,
    bounds: { minX: -36, minZ: -36, maxX: 36, maxZ: 36 },
    exclude: [
      { rect: [0, 0, 22, 19], feather: 0.12 }, { rect: [0, 12, 48, 3], feather: 0.15 },
      { rect: [13.5, 0, 3, 38], feather: 0.15 }, { rect: [-9.8, 0, 1.2, 13.2], feather: 0.1 },
      { rect: [9.8, 0, 1.2, 13.2], feather: 0.1 },
    ],
    wind: { strength: wind },
  })
  grass.object.name = '草坪 · 近景草叶'
  scene.add(forest.object, grass.object)
  excludeFromFraming(forest.object, grass.object, sky.object)
  return {
    sun, sky, forest, grass,
    setHour(value) { sky.setHour(value) },
    sample(time) { forest.update(time); grass.update(time); sky.update(time) },
    dispose() { forest.dispose(); grass.dispose(); sky.dispose() },
  }
}

import * as THREE from 'three'
import { WebGPURenderer, RenderPipeline } from 'three/webgpu'
import { pass } from 'three/tsl'
import { bloom } from 'three/addons/tsl/display/BloomNode.js'
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js'
import { DRACOLoader } from 'three/addons/loaders/DRACOLoader.js'
import { KTX2Loader } from 'three/addons/loaders/KTX2Loader.js'
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js'
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js'
import { GTAOPass } from 'three/addons/postprocessing/GTAOPass.js'
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js'
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js'
import { loadBuilding, addBuildingLights, assetUrl } from '../src/building.js'
import { createRoaming } from '../src/controls.js'
import { createPageEnvironment } from '../src/environment-pages.js'

const BASE = import.meta.env.BASE_URL || '/'
const container = document.getElementById('viewport')
const loading = document.getElementById('loading')
const status = document.getElementById('loading-text')
const abort = new AbortController()

async function createRenderer(canvas) {
  let adapter = null
  if (navigator.gpu) adapter = await navigator.gpu.requestAdapter({ powerPreference: 'high-performance' }).catch(() => null)
  if (adapter) {
    try {
      const renderer = new WebGPURenderer({ canvas, antialias: true, alpha: false, powerPreference: 'high-performance' })
      await renderer.init()
      if (renderer.backend.isWebGPUBackend) return { renderer, webgpu: true, backend: 'WebGPU', supportsASTC: adapter.features.has('texture-compression-astc') }
      renderer.dispose()
    } catch (error) { console.warn('WebGPU 初始化失败，回退 WebGL2', error) }
  }
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: false, powerPreference: 'high-performance' })
  return { renderer, webgpu: false, backend: 'WebGL2', supportsASTC: !!renderer.getContext().getExtension('WEBGL_compressed_texture_astc') }
}

async function main() {
  const { renderer, webgpu, backend, supportsASTC } = await createRenderer(document.getElementById('scene'))
  const dprLimit = Math.min(window.devicePixelRatio || 1, 2)
  let dpr = Math.min(dprLimit, matchMedia('(pointer: coarse)').matches ? 1.35 : 1.65)
  renderer.setPixelRatio(dpr)
  renderer.toneMapping = THREE.ACESFilmicToneMapping
  renderer.toneMappingExposure = 1.0
  renderer.outputColorSpace = THREE.SRGBColorSpace
  renderer.shadowMap.enabled = true
  renderer.shadowMap.type = webgpu ? THREE.PCFShadowMap : THREE.PCFSoftShadowMap
  renderer.info.autoReset = false
  const scene = new THREE.Scene()
  const camera = new THREE.PerspectiveCamera(48, 1, 0.065, 240)
  camera.position.set(24, 22, 30); camera.lookAt(0, 8.2, 0)
  const gltf = new GLTFLoader()
  const draco = new DRACOLoader().setDecoderPath(assetUrl(BASE, 'draco/')).setWorkerLimit(2)
  const ktx2 = new KTX2Loader().setTranscoderPath(assetUrl(BASE, 'basis/')).setWorkerLimit(2).detectSupport(renderer)
  gltf.setDRACOLoader(draco).setKTX2Loader(ktx2)
  const modelFile = supportsASTC ? 'models/model-astc.glb' : 'models/model.glb'
  const building = await loadBuilding(async (url) => {
    const result = await gltf.loadAsync(url)
    return { object: result.scene, animations: result.animations }
  }, BASE, { modelFile })
  draco.dispose(); ktx2.dispose()
  scene.add(building.model)
  const lighting = addBuildingLights(scene)
  const outdoor = await createPageEnvironment(scene, renderer, { base: BASE, webgpu })
  building.setFloor(0); lighting.setFloor(0)
  let composer = null, gtao = null, pipeline = null, scenePass = null
  if (webgpu) {
    scenePass = pass(scene, camera)
    const color = scenePass.getTextureNode('output')
    const glow = bloom(color, 0.10, 0.32, 1.08)
    pipeline = new RenderPipeline(renderer, color.add(glow))
  } else {
    composer = new EffectComposer(renderer)
    composer.addPass(new RenderPass(scene, camera))
    if (!matchMedia('(pointer: coarse)').matches) {
      gtao = new GTAOPass(scene, camera, 640, 360)
      gtao.blendIntensity = 0.48
      composer.addPass(gtao)
    }
    composer.addPass(new UnrealBloomPass(new THREE.Vector2(640, 360), 0.10, 0.28, 1.08))
    composer.addPass(new OutputPass())
  }
  const settings = { walkSpeed: 2.6, runSpeed: 5.0, cameraDistance: 3.4 }
  const game = createRoaming({ canvas: renderer.domElement, container, signal: abort.signal }, scene, { camera, building, lighting, settings, backend })
  building.setFloor(0); lighting.setFloor(0)
  camera.position.set(24, 22, 30); camera.lookAt(0, 8.2, 0)

  function resize() {
    const width = container.clientWidth, height = container.clientHeight
    camera.aspect = width / Math.max(height, 1); camera.updateProjectionMatrix()
    renderer.setPixelRatio(dpr); renderer.setSize(width, height, false)
    if (composer) { composer.setPixelRatio(dpr); composer.setSize(width, height); gtao?.setSize(Math.round(width * dpr * 0.5), Math.round(height * dpr * 0.5)) }
  }
  window.addEventListener('resize', resize, { signal: abort.signal }); resize()
  document.getElementById('backend-label').textContent = `${backend} · ${supportsASTC ? 'ASTC 4×4' : '标准纹理'} · DPR ${dpr.toFixed(2)}`
  document.getElementById('hour').addEventListener('input', (event) => {
    const hour = Number(event.target.value); outdoor.setHour(hour)
    document.getElementById('hour-value').textContent = `${String(Math.floor(hour)).padStart(2, '0')}:${String(Math.round(hour % 1 * 60)).padStart(2, '0')}`
  }, { signal: abort.signal })
  status.textContent = '正在编译材质、阴影和后期…'
  await renderer.compileAsync(scene, camera)
  let last = performance.now(), time = 0, raf = 0, frames = 0, statTime = 0, fps = 0
  const renderInfo = { backend, calls: 0, triangles: 0, fps: 0, dpr, modelFile, textureMode: supportsASTC ? 'ASTC 4x4' : 'portable' }
  function frame(now) {
    raf = requestAnimationFrame(frame)
    const rawDt = Math.max((now - last) / 1000, 0.001)
    const dt = Math.min(rawDt, 0.05); last = now; time += dt
    game.update(dt); outdoor.sample(time)
    renderer.info.reset()
    if (pipeline) pipeline.render()
    else composer.render(dt)
    renderInfo.calls = renderer.info.render.drawCalls ?? renderer.info.render.calls; renderInfo.triangles = renderer.info.render.triangles
    frames++; statTime += rawDt
    if (statTime >= 1) { fps = Math.round(frames / statTime); renderInfo.fps = fps; frames = 0; statTime = 0 }
  }
  raf = requestAnimationFrame(frame)
  window.__building51 = {
    ready: true, scene, camera, renderer, building, game, settings, outdoor, renderInfo,
    getState: () => ({ ...game.state(), ...renderInfo, meshes: (() => { let n = 0; building.model.traverse((o) => { if (o.isMesh && o.visible) n++ }); return n })() }),
    screenshotView(position, lookAt) { camera.position.fromArray(position); camera.lookAt(...lookAt); camera.updateMatrixWorld(); if (pipeline) pipeline.render(); else composer.render() },
    stop() { cancelAnimationFrame(raf) },
  }
  loading.style.opacity = '0'
  setTimeout(() => loading.remove(), 450)
  window.addEventListener('pagehide', () => {
    cancelAnimationFrame(raf); abort.abort(); game.dispose(); outdoor.dispose(); composer?.dispose(); pipeline?.dispose(); renderer.dispose()
  }, { once: true })
}

main().catch((error) => {
  console.error(error)
  status.textContent = '场景启动失败'
  const detail = document.createElement('small'); detail.textContent = `${error.message}。请使用支持 WebGL2 的浏览器，并确认本地模型和解码器完整。`
  loading.append(detail)
})

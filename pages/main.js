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

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

// GitHub Pages throttles a single large request to modem speeds while several
// concurrent requests each get their own share. The models are therefore split
// offline into `.part-NN` files: each part is an ordinary GET the browser can
// gunzip transparently (unlike byte ranges of an on-the-fly-compressed .glb,
// which reassemble into garbage). The manifest lists parts, byte sizes and the
// SHA-256 of the reassembled model; the loader validates magic bytes and size.
const GLB_MAGIC = [0x67, 0x6c, 0x54, 0x46] // "glTF"

function looksLikeGlb(buffer) {
  if (buffer.byteLength < 12) return false
  const head = new Uint8Array(buffer, 0, 4)
  return GLB_MAGIC.every((byte, index) => head[index] === byte)
}

function parseGlb(gltf, buffer) {
  return new Promise((resolve, reject) => gltf.parse(buffer, '', resolve, reject))
}

async function fetchPart(url, expectedBytes) {
  let lastError = null
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const response = await fetch(url)
      if (!response.ok) throw new Error(`HTTP ${response.status}`)
      const buffer = await response.arrayBuffer()
      if (buffer.byteLength !== expectedBytes) throw new Error(`Part size mismatch: ${buffer.byteLength} != ${expectedBytes}`)
      return buffer
    } catch (error) {
      lastError = error
      if (attempt < 2) await delay(300 * (attempt + 1))
    }
  }
  throw lastError
}

async function loadGlbInParts(gltf, url, onProgress) {
  const response = await fetch(`${url}.parts.json`)
  if (!response.ok) throw new Error(`Parts manifest missing: HTTP ${response.status}`)
  const manifest = await response.json()
  const buffers = new Array(manifest.parts.length)
  let next = 0, completed = 0
  async function worker() {
    while (next < manifest.parts.length) {
      const index = next++
      const buffer = await fetchPart(manifest.parts[index], manifest.partBytes[index])
      buffers[index] = buffer
      completed += buffer.byteLength
      onProgress(completed, manifest.bytes)
    }
  }
  await Promise.all(Array.from({ length: Math.min(8, manifest.parts.length) }, worker))
  const output = new Uint8Array(manifest.bytes)
  let offset = 0
  for (const buffer of buffers) { output.set(new Uint8Array(buffer), offset); offset += buffer.byteLength }
  if (!looksLikeGlb(output.buffer)) throw new Error('Reassembled buffer is not a GLB')
  return parseGlb(gltf, output.buffer)
}

async function loadGltfParallel(gltf, url, onProgress = () => {}) {
  const isLocalHost = ['localhost', '127.0.0.1', '[::1]'].includes(location.hostname)
  if (isLocalHost) return gltf.loadAsync(url, (event) => onProgress(event.loaded, event.total || event.loaded))
  try {
    return await loadGlbInParts(gltf, url, onProgress)
  } catch (partError) {
    console.warn('分段模型下载失败，回退为单连接下载', partError)
  }
  return gltf.loadAsync(url, (event) => onProgress(event.loaded, event.total || event.loaded))
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
  const fullModelFile = supportsASTC ? 'models/model-astc.glb' : 'models/model.glb'
  const previewModelFile = 'models/model-preview.glb'
  const assetNames = {
    [previewModelFile]: '快速预览模型',
    [fullModelFile]: '高清建筑模型',
    'models/collision.glb': '碰撞体',
    'models/character.glb': '漫游人物',
  }
  const loadModelAsset = async (url) => {
    const file = decodeURIComponent(url.split('/').pop())
    const label = assetNames[file] || '场景资源'
    const result = await loadGltfParallel(gltf, url, (loaded, total) => {
      const percent = Math.min(100, Math.round(loaded / total * 100))
      status.textContent = `正在下载${label} ${(loaded / 1048576).toFixed(1)} / ${(total / 1048576).toFixed(1)} MB（${percent}%）`
    })
    return { object: result.scene, animations: result.animations }
  }
  const building = await loadBuilding(loadModelAsset, BASE, { modelFile: previewModelFile })
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
  const renderInfo = { backend, calls: 0, triangles: 0, fps: 0, dpr, modelFile: previewModelFile, textureMode: 'fast preview' }
  const assetStatus = document.getElementById('asset-status')
  const setAssetStatus = (text) => {
    if (!assetStatus) return
    assetStatus.hidden = !text
    assetStatus.textContent = text
  }
  async function upgradeToFullModel() {
    try {
      const fullUrl = assetUrl(BASE, fullModelFile)
      const result = await loadGltfParallel(gltf, fullUrl, (loaded, total) => {
        const percent = Math.min(100, Math.round(loaded / total * 100))
        setAssetStatus(`高清材质后台下载中 ${(loaded / 1048576).toFixed(1)} / ${(total / 1048576).toFixed(1)} MB（${percent}%）`)
      })
      building.replaceModel(result.scene)
      renderInfo.modelFile = fullModelFile
      renderInfo.textureMode = supportsASTC ? 'ASTC 4x4' : 'portable'
      document.getElementById('backend-label').textContent = `${backend} · ${supportsASTC ? 'ASTC 4×4' : '标准纹理'} · DPR ${dpr.toFixed(2)}`
      setAssetStatus('高清材质已启用')
      await renderer.compileAsync(scene, camera)
      setTimeout(() => setAssetStatus(''), 1200)
    } catch (error) {
      console.warn('高清模型后台升级失败，继续使用快速预览模型', error)
      setAssetStatus('高清材质暂时下载失败，当前使用快速预览模式')
      setTimeout(() => setAssetStatus(''), 3200)
    } finally {
      draco.dispose(); ktx2.dispose()
    }
  }
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
  setTimeout(() => upgradeToFullModel(), 600)
  window.addEventListener('pagehide', () => {
    cancelAnimationFrame(raf); abort.abort(); game.dispose(); outdoor.dispose(); composer?.dispose(); pipeline?.dispose(); renderer.dispose()
  }, { once: true })
}

main().catch((error) => {
  console.error(error)
  status.textContent = '场景启动失败'
  const detail = document.createElement('small'); detail.textContent = `${error.message}。请使用支持 WebGL2 的浏览器，并确认在线模型和解码器完整。`
  loading.append(detail)
})

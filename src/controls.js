import * as THREE from 'three'
import { Capsule } from 'three/addons/math/Capsule.js'
import { createAvatar, floorAt, SPAWNS, FLOOR_Y } from './building.js'
import { createHUD } from './hud.js'

const clamp = THREE.MathUtils.clamp
const damp = THREE.MathUtils.damp

// Capsule collision is intentionally independent from the visible mesh. The collision GLB
// includes real door openings and smooth ramp colliders underneath the rendered stair treads.
export function createRoaming(context, world, options = {}) {
  const { canvas, container, signal } = context
  const { camera, building, lighting, settings = {}, backend = 'Edit3D', onReady } = options
  const keys = new Set()
  const octree = building.createOctree()
  const capsule = new Capsule(new THREE.Vector3(), new THREE.Vector3(), 0.30)
  const velocity = new THREE.Vector3()
  const direction = new THREE.Vector3()
  const forward = new THREE.Vector3()
  const side = new THREE.Vector3()
  const delta = new THREE.Vector3()
  const target = new THREE.Vector3()
  const desired = new THREE.Vector3()
  const ray = new THREE.Raycaster()
  const groundRay = new THREE.Ray(new THREE.Vector3(), new THREE.Vector3(0, -1, 0))
  const groundNormal = new THREE.Vector3()
  const avatar = createAvatar(building.avatar, building.animations)
  world.add(avatar.object)
  let feet = 0, yaw = 0, pitch = 0.25, grounded = false, started = false, disposed = false
  let view = 'third', distance = settings.cameraDistance || 3.4, currentFloor = 1
  let activeTime = 0, hudTime = 0, frames = 0, fps = 0, lastSafe = new THREE.Vector3(0, 0.1, 10.4)
  let touchJump = false, touchRun = false, drag = null, lookPointer = null
  const virtualKeys = new Set()
  const on = (element, type, handler, opts = {}) => element.addEventListener(type, handler, { ...opts, signal })
  const key = (code) => keys.has(code) || virtualKeys.has(code)
  const setKey = (code, pressed) => pressed ? virtualKeys.add(code) : virtualKeys.delete(code)

  function teleport(floor = currentFloor) {
    const n = clamp(Number(floor) || 1, 1, 6)
    const p = SPAWNS[n]
    feet = p[1]
    capsule.start.set(p[0], feet + capsule.radius, p[2])
    capsule.end.set(p[0], feet + 1.45, p[2])
    velocity.set(0, 0, 0)
    yaw = 0; pitch = 0.25
    lastSafe.copy(capsule.start)
    currentFloor = n
    building.setFloor(n)
    lighting.setFloor(n)
    avatar.object.position.set(p[0], feet, p[2])
    avatar.object.rotation.set(0, Math.PI, 0)
    avatar.play('idle')
    updateCamera(true)
    hud?.setFloor(n)
  }

  function jump() {
    if (grounded) { velocity.y = 5.5; grounded = false; avatar.play('jump', 0.08) }
  }

  function setView(next) {
    view = next || (view === 'third' ? 'first' : 'third')
    avatar.object.visible = view === 'third'
    hud?.setView(view)
    updateCamera(true)
  }

  function playerCollisions() {
    const hit = octree.capsuleIntersect(capsule)
    if (!hit) return
    const floorHit = hit.normal.y > 0.22
    grounded ||= floorHit
    if (!floorHit) velocity.addScaledVector(hit.normal, -hit.normal.dot(velocity))
    else if (velocity.y < 0) velocity.y = 0
    if (hit.depth >= 1e-10) capsule.translate(hit.normal.multiplyScalar(hit.depth))
  }

  function updatePlayer(dt) {
    const f = clamp((key('KeyW') || key('ArrowUp') ? 1 : 0) - (key('KeyS') || key('ArrowDown') ? 1 : 0) - hud.joystick.y, -1, 1)
    const s = clamp((key('KeyD') || key('ArrowRight') ? 1 : 0) - (key('KeyA') || key('ArrowLeft') ? 1 : 0) + hud.joystick.x, -1, 1)
    const running = key('ShiftLeft') || key('ShiftRight') || touchRun
    const speed = running ? (settings.runSpeed || 5.0) : (settings.walkSpeed || 2.6)
    forward.set(-Math.sin(yaw), 0, -Math.cos(yaw))
    side.set(-forward.z, 0, forward.x)
    direction.set(0, 0, 0).addScaledVector(forward, f).addScaledVector(side, s)
    if (direction.lengthSq() > 1) direction.normalize()
    const control = grounded ? 14 : 4
    velocity.x = damp(velocity.x, direction.x * speed, control, dt)
    velocity.z = damp(velocity.z, direction.z * speed, control, dt)
    if (!grounded) velocity.y -= 18 * dt
    else if (velocity.y < 0) velocity.y = 0
    if (key('Space') || touchJump) { jump(); touchJump = false }
    delta.copy(velocity).multiplyScalar(dt)
    grounded = false
    capsule.translate(delta)
    // Repeated solver passes also resolve furniture corners rather than tunnelling along a wall.
    for (let i = 0; i < 4; i++) playerCollisions()
    // Exact floor contact can alternate between touching and not intersecting. A short
    // downward ray keeps grounding stable and also snaps the capsule to stair ramps.
    if (!grounded && velocity.y <= 0) {
      groundRay.origin.copy(capsule.start)
      const groundHit = octree.rayIntersect(groundRay)
      if (groundHit && groundHit.distance <= capsule.radius + 0.10) {
        groundHit.triangle.getNormal(groundNormal)
        if (groundNormal.y > 0.35) {
          const correction = groundHit.distance - capsule.radius
          capsule.start.y -= correction; capsule.end.y -= correction
          grounded = true; velocity.y = 0
        }
      }
    }
    feet = capsule.start.y - capsule.radius
    const p = avatar.object.position.set(capsule.start.x, feet, capsule.start.z)
    const moving = Math.hypot(velocity.x, velocity.z)
    if (moving > 0.16) {
      const wanted = Math.atan2(velocity.x, velocity.z)
      let turn = ((wanted - avatar.object.rotation.y + Math.PI) % (Math.PI * 2)) - Math.PI
      if (turn < -Math.PI) turn += Math.PI * 2
      avatar.object.rotation.y += turn * (1 - Math.exp(-14 * dt))
    }
    avatar.play(grounded ? (moving > 3.25 ? 'run' : moving > 0.18 ? 'walk' : 'idle') : 'jump')
    avatar.mixer.update(dt)
    if (grounded && feet > -1 && Math.abs(p.x) < 34 && Math.abs(p.z) < 34) lastSafe.copy(capsule.start)
    if (feet < -7 || Math.abs(p.x) > 65 || Math.abs(p.z) > 65) teleport(currentFloor)
    const nextFloor = floorAt(feet)
    if (nextFloor !== currentFloor) {
      currentFloor = nextFloor
      building.setFloor(nextFloor); lighting.setFloor(nextFloor); hud.setFloor(nextFloor)
    }
  }

  function updateCamera(immediate = false, dt = 1 / 60) {
    target.copy(capsule.start).add(new THREE.Vector3(0, view === 'third' ? 0.95 : 1.30, 0))
    const cp = Math.cos(pitch), sp = Math.sin(pitch)
    forward.set(-Math.sin(yaw) * cp, -sp, -Math.cos(yaw) * cp)
    let actualDistance = distance
    if (view === 'third') {
      desired.copy(target).addScaledVector(forward, -distance)
      ray.set(target, desired.clone().sub(target).normalize())
      ray.far = distance
      const hits = ray.intersectObject(building.model, true).filter((hit) => {
        let object = hit.object
        while (object) { if (!object.visible) return false; object = object.parent }
        return hit.object.material?.transparent !== true
      })
      if (hits.length) actualDistance = Math.max(0.18, hits[0].distance - 0.18)
      desired.copy(target).addScaledVector(forward, -actualDistance)
      if (immediate) camera.position.copy(desired)
      else camera.position.lerp(desired, 1 - Math.exp(-18 * dt))
      // A shortened indoor boom must not put the near plane inside the avatar's head.
      avatar.object.visible = actualDistance > 0.62
      camera.lookAt(target)
    } else {
      avatar.object.visible = false
      camera.position.copy(target)
      camera.lookAt(target.clone().add(forward))
    }
    camera.updateMatrixWorld()
  }

  function look(dx, dy) {
    yaw -= dx * 0.0026
    pitch = clamp(pitch - dy * 0.0026, -0.32, 1.12)
  }

  const hud = createHUD(container, signal, {
    embedded: !!options.embedded,
    onStart() { started = true; teleport(currentFloor); canvas.focus(); options.onStart?.() },
    onFloor: teleport,
    onView: () => setView(),
    onJump: () => { touchJump = true },
    onRun(value) { touchRun = value },
    onFullscreen: async () => {
      try {
        if (document.fullscreenElement) await document.exitFullscreen()
        else await container.requestFullscreen()
      } catch { hud.toast('此设备暂不支持全屏，可使用横屏浏览') }
    },
    onHelp: () => { keys.clear() },
  })
  hud.setBackend(backend)
  hud.setFloor(1)
  on(canvas, 'keydown', (event) => {
    if (['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Space'].includes(event.code)) event.preventDefault()
    keys.add(event.code)
    // Register short taps immediately; a down/up pair can fit between low-FPS frames.
    if (event.code === 'Space' && !event.repeat) jump()
    if (event.code === 'KeyV' && !event.repeat) setView()
    if (event.code === 'KeyH' && !event.repeat) hud.toggleHelp()
    if (/^Digit[1-6]$/.test(event.code) && !event.repeat) teleport(Number(event.code.slice(-1)))
  })
  on(canvas, 'keyup', (event) => keys.delete(event.code))
  on(canvas, 'blur', () => { keys.clear(); virtualKeys.clear(); drag = null })
  on(canvas, 'pointerdown', (event) => {
    canvas.focus()
    if (event.pointerType === 'touch') {
      if (event.clientX > canvas.clientWidth * 0.38) { lookPointer = { id: event.pointerId, x: event.clientX, y: event.clientY }; canvas.setPointerCapture(event.pointerId) }
      return
    }
    drag = { id: event.pointerId, x: event.clientX, y: event.clientY }
    canvas.setPointerCapture(event.pointerId)
  })
  on(canvas, 'pointermove', (event) => {
    if (document.pointerLockElement === canvas) { look(event.movementX, event.movementY); return }
    const pointer = event.pointerType === 'touch' ? lookPointer : drag
    if (pointer?.id === event.pointerId) { look(event.clientX - pointer.x, event.clientY - pointer.y); pointer.x = event.clientX; pointer.y = event.clientY }
  })
  on(canvas, 'pointerup', (event) => { if (drag?.id === event.pointerId) drag = null; if (lookPointer?.id === event.pointerId) lookPointer = null })
  on(canvas, 'pointercancel', () => { drag = null; lookPointer = null })
  on(canvas, 'dblclick', () => {
    if (!canvas.requestPointerLock || matchMedia('(pointer: coarse)').matches) return
    try { const result = canvas.requestPointerLock(); result?.catch?.(() => {}) } catch { /* drag remains available */ }
  })
  on(canvas, 'wheel', (event) => { event.preventDefault(); distance = clamp(distance + event.deltaY * 0.003, 1.4, 7.0) }, { passive: false })
  on(document, 'pointerlockchange', () => hud.toast(document.pointerLockElement === canvas ? '鼠标已锁定，Esc 释放' : '可拖拽环顾，双击锁定鼠标'))

  teleport(options.initialFloor || 1)
  if (!options.embedded) hud.showEntry(true)
  else { started = true; hud.showEntry(false) }
  onReady?.()

  // Position a QA starting point only; traversal tests still use real key or touch input.
  function setPose(position, yawValue = 0, pitchValue = 0.25) {
    if (!Array.isArray(position) || position.length !== 3 || position.some((n) => !Number.isFinite(n))) throw new TypeError('setPose 需要 [x, y, z]')
    feet = position[1]
    capsule.start.set(position[0], feet + capsule.radius, position[2])
    capsule.end.set(position[0], feet + 1.45, position[2])
    velocity.set(0, 0, 0); grounded = false
    yaw = yawValue; pitch = clamp(pitchValue, -0.32, 1.12)
    currentFloor = floorAt(feet)
    building.setFloor(currentFloor); lighting.setFloor(currentFloor); hud.setFloor(currentFloor)
    avatar.object.position.fromArray(position)
    avatar.object.rotation.set(0, Math.PI, 0); avatar.play('idle')
    lastSafe.copy(capsule.start)
    updateCamera(true)
  }

  const api = {
    update(dt) {
      if (disposed || !started) return
      dt = Math.min(dt, 0.05)
      const substeps = Math.max(1, Math.ceil(dt / (1 / 90)))
      for (let i = 0; i < substeps; i++) updatePlayer(dt / substeps)
      updateCamera(false, dt)
      activeTime += dt; frames++; hudTime += dt
      if (hudTime >= 0.25) {
        fps = Math.round(frames / hudTime)
        hud.update(capsule.start, currentFloor, { fps, yaw, grounded, view, speed: Math.hypot(velocity.x, velocity.z) })
        frames = 0; hudTime = 0
      }
    },
    teleport,
    setPose,
    setView,
    setKey,
    look,
    jump,
    state() {
      return {
        floor: currentFloor, feet: +feet.toFixed(3), position: avatar.object.position.toArray().map((n) => +n.toFixed(3)),
        camera: camera.position.toArray().map((n) => +n.toFixed(3)), grounded, view, yaw: +yaw.toFixed(3), pitch: +pitch.toFixed(3),
        animation: avatar.current, fps, started, triangles: building.model.userData.triangles || 478352,
        visibleFloors: [...Array(6)].map((_, i) => i + 1).filter((floor) => floor === currentFloor),
      }
    },
    probe(point = capsule.start) { const hit = octree.capsuleIntersect(capsule); return hit ? { normal: hit.normal.toArray(), depth: hit.depth } : null },
    dispose() {
      disposed = true; started = false; keys.clear(); virtualKeys.clear(); hud.dispose(); avatar.dispose(); world.remove(avatar.object)
      if (document.pointerLockElement === canvas) document.exitPointerLock()
      if (window.__building51Play === api) delete window.__building51Play
    },
  }
  // Public QA and integration hooks, not private SDK state.
  window.__building51Play = api
  container.building51 = api
  return api
}

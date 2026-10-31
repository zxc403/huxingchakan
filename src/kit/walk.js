// First-person roaming for a game-template Play session (architecture, interiors, levels).
// Walk: WASD / arrows move, drag looks around, Shift runs, Space jumps (with ground).
// Fly (F or the button): E / Space rise, Q / C descend, no gravity or walls, for overviews.
// The SDK disables its own orbit camera in Play, so the work must provide controls.
import * as THREE from 'three'

// Axis-aligned colliders from objects (walls, furniture). Call after scene.updateMatrixWorld(true),
// at Play start so user edits (moved/resized furniture) are respected.
export function collidersFrom(objects, pad = 0) {
  return objects.map((o) => new THREE.Box3().setFromObject(o).expandByScalar(pad))
}

// ctx: the play({ canvas, container, signal }) argument.
// spots: [{ label, position: [x, floorY, z], yaw, pitch }] (position is where the feet stand).
// ground: floors / terrain / stairs to stand on (raycast down; leave furniture out). With ground,
// walking follows levels and stairs (steps up to maxStep), falls with gravity and refuses to walk
// off edges into the void. Without ground, the feet stay at the current spot's height.
// hint and labels are on-screen text: the defaults are Chinese; pass them in the user's language.
export function createWalk(ctx, camera, {
  colliders = [], ground = [], eye = 1.6, speed = 2.2, radius = 0.25, maxStep = 0.45, spots = [], initialPitch = -0.08,
  hint = 'WASD 移动 · 拖拽环顾 · Shift 加速 · F 飞行（E 上升 / Q 下降）',
  labels = { fly: '飞行 F', walk: '步行 F' },
} = {}) {
  const { canvas, container, signal } = ctx
  const keys = new Set()
  const on = (el, type, fn) => el.addEventListener(type, fn, { signal })
  const look = new THREE.Vector3()
  camera.getWorldDirection(look)
  let yaw = Math.atan2(-look.x, -look.z), pitch = initialPitch
  let dragging = false, lx = 0, ly = 0, flying = false, vy = 0
  let feet = spots[0] ? spots[0].position[1] : camera.position.y - eye

  // Ground excluded from edit-view framing (edit3d.js excludeFromFraming) has an empty box that
  // raycasts skip; Play runs its own scene instance, so give those boxes back here.
  for (const root of ground) root.traverse((o) => {
    if (o.geometry?.boundingBox?.isEmpty()) o.geometry.computeBoundingBox()
    if (o.boundingBox?.isEmpty?.()) o.computeBoundingBox()
  })
  const ray = new THREE.Raycaster(), down = new THREE.Vector3(0, -1, 0), origin = new THREE.Vector3()
  // Highest walkable surface under (x, z) that is at most maxStep above `from`; null when none.
  const groundAt = (x, z, from) => {
    if (!ground.length) return from
    origin.set(x, from + maxStep + 0.01, z)
    ray.set(origin, down); ray.far = maxStep + 200
    const hit = ray.intersectObjects(ground, true)[0]
    return hit ? hit.point.y : null
  }
  const safe = { x: camera.position.x, z: camera.position.z, feet }

  on(canvas, 'keydown', (e) => {
    keys.add(e.code)
    if (e.code.startsWith('Arrow') || e.code === 'Space') e.preventDefault()
    if (e.code === 'KeyF' && !e.repeat) setFlying(!flying)
    if (e.code === 'Space' && !flying && ground.length && vy === 0) vy = 4.2
  })
  on(canvas, 'keyup', (e) => keys.delete(e.code))
  on(canvas, 'blur', () => keys.clear())
  on(canvas, 'pointerdown', (e) => { dragging = true; lx = e.clientX; ly = e.clientY; canvas.focus(); canvas.setPointerCapture(e.pointerId) })
  on(canvas, 'pointerup', () => { dragging = false })
  on(canvas, 'pointermove', (e) => {
    if (!dragging) return
    yaw -= (e.clientX - lx) * 0.004
    pitch = THREE.MathUtils.clamp(pitch - (e.clientY - ly) * 0.004, -1.4, 1.4)
    lx = e.clientX; ly = e.clientY
  })

  // HUD is visible from the first Play frame; only buttons take pointer input.
  const hud = document.createElement('div')
  hud.style.cssText = 'position:absolute;left:16px;right:16px;bottom:16px;display:flex;gap:8px;flex-wrap:wrap;align-items:center;pointer-events:none;font:13px system-ui,sans-serif'
  const tip = document.createElement('span')
  tip.textContent = hint
  tip.style.cssText = 'background:rgba(0,0,0,.6);color:#fff;padding:8px 12px;border-radius:8px'
  const button = (label, fn) => {
    const b = document.createElement('button')
    b.textContent = label
    b.style.cssText = 'pointer-events:auto;background:rgba(255,255,255,.92);color:#222;border:0;border-radius:8px;padding:8px 12px;cursor:pointer;font:inherit'
    on(b, 'click', () => { fn(); canvas.focus() })
    hud.append(b)
    return b
  }
  hud.append(tip)
  const flyButton = button(labels.fly, () => setFlying(!flying))
  function setFlying(value) {
    flying = value; vy = 0
    flyButton.textContent = flying ? labels.walk : labels.fly
    if (!flying) { // land on whatever is below; over the void, return to the last place you stood
      feet = camera.position.y - eye
      if (ground.length && groundAt(camera.position.x, camera.position.z, feet) === null) {
        camera.position.set(safe.x, safe.feet + eye, safe.z); feet = safe.feet
      }
    }
  }
  const goto = (s) => {
    camera.position.set(s.position[0], s.position[1] + eye, s.position[2])
    feet = s.position[1]; vy = 0
    if (s.yaw !== undefined) yaw = s.yaw
    pitch = s.pitch ?? initialPitch
  }
  for (const s of spots) button(s.label, () => { setFlying(false); goto(s) })
  if (spots[0]) goto(spots[0]) // enter at the first spot, not wherever the overview camera was
  if (ground.length) { const g = groundAt(camera.position.x, camera.position.z, feet); if (g !== null) feet = g }
  camera.position.y = feet + eye
  Object.assign(safe, { x: camera.position.x, z: camera.position.z, feet })
  container.append(hud)
  canvas.focus()

  const fwd = new THREE.Vector3(), side = new THREE.Vector3(), centre = new THREE.Vector3(), body = new THREE.Box3()
  const blocked = (p, footY) => {
    const h = eye - (ground.length ? Math.min(maxStep, eye * 0.3) : 0.05) // with ground, steps are climbed, not walls
    body.setFromCenterAndSize(centre.set(p.x, footY + eye - h / 2, p.z), new THREE.Vector3(radius * 2, h, radius * 2))
    return colliders.some((b) => b.intersectsBox(body))
  }
  const step = new THREE.Vector3(), trial = new THREE.Vector3()
  return {
    update(dt) {
      const f = (keys.has('KeyW') || keys.has('ArrowUp')) - (keys.has('KeyS') || keys.has('ArrowDown'))
      const s = (keys.has('KeyD') || keys.has('ArrowRight')) - (keys.has('KeyA') || keys.has('ArrowLeft'))
      const run = keys.has('ShiftLeft') || keys.has('ShiftRight') ? 2 : 1
      const v = speed * run * (flying ? 2 : 1) * dt
      fwd.set(-Math.sin(yaw), 0, -Math.cos(yaw)); side.set(-fwd.z, 0, fwd.x)
      if (flying) {
        const u = (keys.has('KeyE') || keys.has('Space')) - (keys.has('KeyQ') || keys.has('KeyC') || keys.has('ControlLeft'))
        camera.position.addScaledVector(fwd, f * v).addScaledVector(side, s * v)
        camera.position.y += u * v
      } else {
        for (const [axis, amount] of [[fwd, f * v], [side, s * v]]) { // per axis, so you slide along walls
          if (!amount) continue
          trial.copy(camera.position).add(step.copy(axis).multiplyScalar(amount))
          const g = groundAt(trial.x, trial.z, feet)
          if (g === null || blocked(trial, Math.max(feet, g))) continue // void or wall
          camera.position.x = trial.x; camera.position.z = trial.z
        }
        if (ground.length) {
          const g = groundAt(camera.position.x, camera.position.z, feet)
          if (vy > 0 || (g !== null && g < feet - 0.02)) { vy -= 9.8 * dt; feet += vy * dt }
          if (g !== null && feet <= g) { feet = g; vy = 0; Object.assign(safe, { x: camera.position.x, z: camera.position.z, feet }) }
        }
        camera.position.y = feet + eye
      }
      camera.rotation.set(pitch, yaw, 0, 'YXZ')
    },
    // QA hooks: jump to a spot by label or index, read the current state.
    goto(which) { const s = typeof which === 'number' ? spots[which] : spots.find((x) => x.label === which); if (s) { setFlying(false); goto(s) } },
    state: () => ({ position: camera.position.toArray().map((n) => +n.toFixed(2)), feet: +feet.toFixed(2), flying, yaw: +yaw.toFixed(2) }),
    dispose() { hud.remove(); keys.clear() },
  }
}

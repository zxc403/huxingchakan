// Edit3D integration helpers that remove the two most common silent failures:
// parameters that never apply, and an edit view that looks at nothing inside Kimi.
import * as THREE from 'three'

// registerParams + subscribe + first apply in one call. asset.subscribe takes ONE function;
// subscribe('change', fn) compiles, logs "Edit3D listener: TypeError" and never applies anything.
// Returns the unsubscribe function: call it in the scene's dispose().
export function bindParams(asset, id, settings, schema, apply, options) {
  asset.registerParams(id, settings, schema, options)
  const off = asset.subscribe(({ type }) => { if (type === 'change') apply(settings) })
  apply(settings)
  return off
}

// Inside Kimi (embedded editor) the edit view starts at the main camera's position but looks at,
// and orbits around, the centre of the WHOLE scene's bounding box; F-focus frames the selected
// object's box. A 1 km ocean or terrain that runs
// 200 m inland drags the pivot away from the subject: orbiting swings the subject out of view and
// focus lands kilometres away in the fog (a blank, sky-coloured view). An empty geometry box takes
// a mesh out of those boxes and out of picking, while it still renders and casts shadows.
// Use on scenery around the subject: ocean, sky dome, terrain, distant mountains. Picking and
// raycasts skip excluded meshes; kits/walk.js restores the boxes of its `ground` in Play.
export function excludeFromFraming(...objects) {
  for (const root of objects) root.traverse((o) => {
    if (!o.geometry) return
    o.geometry.boundingBox = new THREE.Box3()
    if (o.boundingBox !== undefined) o.boundingBox = new THREE.Box3() // InstancedMesh / SkinnedMesh
  })
}

// Where the embedded editor will pivot relative to the subject. ok: the pivot falls inside the
// subject's neighbourhood (a large ground centred on the subject is fine).
export function framingReport(scene, subject) {
  scene.updateMatrixWorld(true)
  const all = new THREE.Box3().setFromObject(scene), sub = new THREE.Box3().setFromObject(subject)
  const pivot = all.getCenter(new THREE.Vector3()), centre = sub.getCenter(new THREE.Vector3())
  const subjectSize = sub.getSize(new THREE.Vector3()).length(), sceneSize = all.getSize(new THREE.Vector3()).length()
  const offset = pivot.distanceTo(centre)
  return { pivot: pivot.toArray().map((v) => +v.toFixed(2)), offset: +offset.toFixed(2), subjectSize: +subjectSize.toFixed(2), sceneSize: +sceneSize.toFixed(2), ok: offset < Math.max(subjectSize * 0.6, 0.5) }
}

// The page runs in one of two phases, chosen by src/review.js: a content preview of the main camera
// while the review is pending (container.edit3dPreview), the editor once it has passed
// (container.edit3dProject.currentEditor). The QA helpers below work in both.
function stage() {
  const app = document.getElementById('app')
  const editor = app?.edit3dProject?.currentEditor
  if (editor) return {
    scene: editor.scene, asset: editor.asset, fov: editor.camera.fov, canvas: editor.renderer.domElement,
    current: { label: 'Current edit view', ...editor.captureView() },
    draw(position, lookAt, aspect) {
      const cam = editor.camera.clone()
      cam.aspect = aspect; cam.updateProjectionMatrix()
      cam.position.fromArray(position); cam.lookAt(...lookAt); cam.updateMatrixWorld(true)
      const size = editor.renderer.getSize(new THREE.Vector2())
      editor.renderer.setScissorTest(false); editor.renderer.setViewport(0, 0, size.x, size.y)
      editor.renderer.render(editor.scene, cam)
    },
    done: () => editor.invalidate(),
  }
  const preview = app?.edit3dPreview, session = preview?.getScene?.()
  if (session) {
    const cam = session.camera, saved = { position: cam.position.clone(), quaternion: cam.quaternion.clone() }
    const ahead = cam.getWorldDirection(new THREE.Vector3()).multiplyScalar(10).add(cam.position)
    return {
      scene: session.scene, asset: session.asset, fov: cam.fov ?? 45, canvas: preview.canvas,
      current: { label: 'Main camera (content preview)', position: cam.position.toArray(), lookAt: ahead.toArray() },
      draw(position, lookAt) { cam.position.fromArray(position); cam.lookAt(...lookAt); preview.render() },
      done() { cam.position.copy(saved.position); cam.quaternion.copy(saved.quaternion); preview.render() },
    }
  }
  return null
}

// QA: several views in ONE screenshot. Run from the browser tool's evaluate:
//   const { contactSheet } = await import('/src/kit/edit3d.js'); contactSheet({ subject: 'house' })
// then take one canvas screenshot. Tile 1 is what the user sees on open (the main camera while the
// review is pending, the edit view after it passed), the others orbit the subject (a registered id;
// default: the whole scene). Pass views: [{ label, position, lookAt }] for exact shots. Returns the
// tile labels; a click on the overlay, the next call or removeContactSheet() removes it.
export function contactSheet({ subject, views, cols = 2 } = {}) {
  const st = stage()
  if (!st) throw new Error('contactSheet: neither the content preview nor the editor is mounted')
  const { scene, asset, canvas } = st
  removeContactSheet()
  if (!views) {
    const target = (subject && asset.getEntity(subject)?.object) || scene
    const box = new THREE.Box3().setFromObject(target), c = box.getCenter(new THREE.Vector3())
    const r = Math.max(box.getSize(new THREE.Vector3()).length() / 2, 0.1)
    const d = r / Math.sin(THREE.MathUtils.degToRad(st.fov) / 2) * 0.9
    const orbit = (az, el) => [c.x + d * Math.cos(el) * Math.sin(az), c.y + d * Math.sin(el), c.z + d * Math.cos(el) * Math.cos(az)]
    views = [
      st.current,
      { label: 'Front', position: orbit(0, 0.25), lookAt: c.toArray() },
      { label: 'Front-right 3/4', position: orbit(0.9, 0.35), lookAt: c.toArray() },
      { label: 'Back-left, from above', position: orbit(-2.4, 0.8), lookAt: c.toArray() },
    ]
  }
  const rows = Math.ceil(views.length / cols), W = canvas.width, H = canvas.height, tw = W / cols, th = H / rows
  const sheet = document.createElement('canvas')
  sheet.id = '__contact_sheet'; sheet.width = W; sheet.height = H
  const rect = canvas.getBoundingClientRect()
  sheet.style.cssText = `position:fixed;left:${rect.left}px;top:${rect.top}px;width:${rect.width}px;height:${rect.height}px;z-index:2147483647`
  const ctx = sheet.getContext('2d')
  views.forEach((v, i) => {
    st.draw(v.position, v.lookAt, tw / th)
    const x = (i % cols) * tw, y = Math.floor(i / cols) * th
    ctx.drawImage(canvas, 0, 0, W, H, x, y, tw, th) // same task as render: no preserveDrawingBuffer needed
    ctx.font = `${Math.round(H / 32)}px system-ui,sans-serif`; ctx.fillStyle = 'rgba(0,0,0,.6)'
    ctx.fillRect(x, y, ctx.measureText(v.label).width + H / 32, H / 20); ctx.fillStyle = '#fff'; ctx.fillText(v.label, x + H / 64, y + H / 28)
    ctx.strokeStyle = '#fff'; ctx.lineWidth = 2; ctx.strokeRect(x, y, tw, th)
  })
  document.body.append(sheet)
  sheet.addEventListener('pointerdown', removeContactSheet)
  st.done()
  return views.map((v) => v.label)
}
export function removeContactSheet() {
  const sheet = document.getElementById('__contact_sheet')
  if (sheet) { sheet.remove(); document.getElementById('app')?.edit3dProject?.currentEditor?.invalidate() }
}

// QA: silent visual faults the edit view and screenshots can hide. Run from evaluate in either phase:
//   const { sceneLint } = await import('/src/kit/edit3d.js'); sceneLint()
// Returns a list of problems (empty when clean): materials with vertexColors on geometry that has
// no colour attribute (they render black), unnamed materials (blank cards in the material panel),
// and left bones (arm_L, ear_L_1, ear.L) without their right partner (a missing ear or arm).
export function sceneLint(scene = stage()?.scene) {
  if (!scene) throw new Error('sceneLint: no scene')
  const out = [], seen = new Set(), bones = new Set()
  scene.traverse((o) => {
    if (o.isBone) bones.add(o.name)
    if (!o.isMesh && !o.isPoints && !o.isLine) return
    for (const m of [].concat(o.material ?? [])) {
      if (m.vertexColors && !o.geometry?.attributes?.color) out.push(`black: material "${m.name || '(unnamed)'}" on "${o.name || o.parent?.name || '(unnamed mesh)'}" has vertexColors but the geometry has no colour attribute (instance colours do not need vertexColors)`)
      if (!m.name && !seen.has(m)) out.push(`unnamed material on "${o.name || o.parent?.name || '(unnamed mesh)'}" (blank card in the material panel)`)
      seen.add(m)
    }
  })
  const LEFT = /([._])L(?=$|[._0-9])/
  for (const b of bones) if (LEFT.test(b) && !bones.has(b.replace(LEFT, '$1R'))) out.push(`bone "${b}" has no right partner "${b.replace(LEFT, '$1R')}"`)
  return [...new Set(out)]
}

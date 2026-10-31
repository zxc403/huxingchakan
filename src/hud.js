const CSS = `
.b51-hud{--paper:#f3eee5;--ink:#25372f;--gold:#ba9465;position:absolute;inset:0;z-index:20;pointer-events:none;color:var(--paper);font:13px/1.5 "Microsoft YaHei",system-ui,sans-serif;letter-spacing:.02em;user-select:none;-webkit-user-select:none}
.b51-hud *{box-sizing:border-box}.b51-hud button{font:inherit;cursor:pointer;pointer-events:auto;touch-action:manipulation}.b51-top{position:absolute;left:26px;top:23px;text-shadow:0 2px 15px #0006}.b51-brand{font-family:Georgia,"Microsoft YaHei",serif;font-size:23px;letter-spacing:.1em}.b51-sub{margin-top:3px;font-size:11px;opacity:.75;letter-spacing:.19em}.b51-floor-tag{position:absolute;left:27px;top:92px;padding:6px 12px;border-left:2px solid var(--gold);background:linear-gradient(90deg,#182b26bb,transparent);font-size:12px}.b51-floors{position:absolute;right:25px;top:26px;display:flex;gap:5px;pointer-events:auto;padding:5px;background:#15241ecc;border:1px solid #ffffff26;border-radius:4px;backdrop-filter:blur(12px)}
.b51-floors button{width:37px;height:35px;color:#f4f0e9;background:transparent;border:0;border-bottom:2px solid transparent}.b51-floors button:hover,.b51-floors button.active{background:#ffffff12;border-color:var(--gold);color:#f4cc99}.b51-actions{position:absolute;right:26px;top:84px;display:flex;gap:6px}.b51-actions button,.b51-help button{border:1px solid #ffffff30;background:#15241ecc;color:#f5f2e9;border-radius:4px;padding:6px 10px;backdrop-filter:blur(10px)}
.b51-help{position:absolute;left:26px;bottom:29px;width:255px;background:#15241eea;border:1px solid #ffffff26;padding:17px 19px;border-radius:5px;pointer-events:auto;backdrop-filter:blur(12px);box-shadow:0 8px 30px #0003}.b51-help[hidden]{display:none}.b51-help h3{font-size:14px;font-weight:500;margin:0 0 10px;color:#f3d7b1}.b51-help p{font-size:12px;opacity:.85;margin:5px 0}.b51-help .close{float:right;border:0;padding:0 3px;background:none}.b51-hint{position:absolute;bottom:27px;left:50%;transform:translateX(-50%);white-space:nowrap;background:#15241ebd;border:1px solid #ffffff24;border-radius:4px;padding:8px 15px;font-size:12px;backdrop-filter:blur(10px)}
.b51-map{position:absolute;right:26px;bottom:29px;width:160px;height:160px;border:1px solid #ffffff30;border-radius:5px;background:#15241edb;box-shadow:0 5px 25px #0003}.b51-map canvas{display:block;width:100%;height:100%;border-radius:4px}.b51-status{position:absolute;left:27px;bottom:30px;width:177px;text-shadow:0 1px 5px #0008}.b51-status-line{display:flex;justify-content:space-between;margin:5px 0 3px;font-size:10px}.b51-bar{height:3px;background:#ffffff26;margin-bottom:7px}.b51-bar i{display:block;height:100%;width:100%;background:#80bca2;transition:width .25s}.b51-bar.blue i{background:#8bbacb}.b51-metrics{font-size:10px;opacity:.72;margin-top:8px;letter-spacing:.03em}
.b51-entry{position:absolute;inset:0;display:grid;place-items:center;background:linear-gradient(90deg,#0d1c17e8,#0d1c1770 60%,#0d1c1733);pointer-events:auto}.b51-entry[hidden]{display:none}.b51-card{width:min(520px,calc(100% - 44px));margin-right:30%;padding:35px;border-left:1px solid #d7b58a80}.b51-overline{font-size:11px;color:#d2b185;letter-spacing:.3em}.b51-card h1{font:400 clamp(29px,4vw,47px)/1.35 Georgia,"Microsoft YaHei",serif;letter-spacing:.12em;margin:16px 0}.b51-card p{color:#d8d8cd;line-height:1.9;font-size:13px;max-width:410px}.b51-enter{margin-top:17px;background:#e3d2b7;color:#23342c;border:0;padding:12px 39px;border-radius:2px;letter-spacing:.22em;font-size:14px!important}.b51-enter:hover{background:#fff1db}.b51-legend{display:flex;gap:23px;margin-top:27px;color:#b6c1b9;font-size:11px}.b51-legend span:before{content:"";display:inline-block;width:5px;height:5px;background:var(--gold);border-radius:50%;margin-right:8px;vertical-align:1px}.b51-toast{position:absolute;top:140px;left:50%;transform:translateX(-50%);background:#15241eef;border:1px solid #ffffff33;padding:8px 17px;border-radius:4px;opacity:0;transition:opacity .2s;white-space:nowrap}.b51-toast.show{opacity:1}.b51-joystick,.b51-jump,.b51-run{display:none}.b51-portrait{display:none}
@media (max-width:900px),(pointer:coarse){.b51-top{left:16px;top:14px}.b51-brand{font-size:17px}.b51-sub{font-size:9px}.b51-floor-tag{left:16px;top:66px;font-size:10px}.b51-floors{top:12px;right:12px;gap:0;padding:3px}.b51-floors button{width:30px;height:30px;font-size:11px}.b51-actions{right:12px;top:55px}.b51-actions button{font-size:10px;padding:5px 7px}.b51-hint{bottom:8px;font-size:9px;padding:5px 9px}.b51-map{width:98px;height:98px;right:14px;top:99px;bottom:auto}.b51-status{left:16px;bottom:143px;width:125px}.b51-metrics{font-size:9px}.b51-help{left:50%;top:50%;bottom:auto;transform:translate(-50%,-50%);width:min(320px,85%)}.b51-joystick{display:block;position:absolute;left:27px;bottom:31px;width:99px;height:99px;border:1px solid #ffffff45;border-radius:50%;background:#15241e50;pointer-events:auto;touch-action:none}.b51-stick{position:absolute;left:31px;top:31px;width:35px;height:35px;border:1px solid #ffffff66;border-radius:50%;background:#f4f0e952;pointer-events:none}.b51-jump,.b51-run{display:block;position:absolute;right:28px;bottom:41px;width:62px;height:62px;border-radius:50%;border:1px solid #ffffff60;background:#e3d2b733;color:#fff;font-size:12px;touch-action:none}.b51-run{right:106px;bottom:31px;width:45px;height:45px;font-size:10px}.b51-run.on{background:#ba946699}.b51-card{margin:0;padding:24px}.b51-card h1{font-size:28px}.b51-legend{gap:11px;font-size:9px}.b51-entry{background:#0d1c17c9}.b51-toast{top:90px;font-size:11px}.b51-card p{font-size:12px}}
@media (max-width:620px){.b51-brand{font-size:14px}.b51-sub{display:none}.b51-floors{top:54px;right:10px}.b51-actions{top:13px}.b51-floor-tag{top:54px}.b51-map{top:105px}.b51-hint{display:none}.b51-card h1{font-size:25px}.b51-legend{flex-wrap:wrap}}
@media (orientation:portrait) and (max-width:600px){.b51-portrait{display:block;position:absolute;left:50%;bottom:13px;transform:translateX(-50%);font-size:10px;color:#f0d9b8;white-space:nowrap}}
`
let styleInstalled = false

export function createHUD(container, signal, callbacks) {
  if (!styleInstalled) { const style = document.createElement('style'); style.textContent = CSS; document.head.append(style); styleInstalled = true }
  const root = document.createElement('div')
  root.className = 'b51-hud'
  root.innerHTML = `
    <div class="b51-top"><div class="b51-brand">3栋51# 建筑漫游</div><div class="b51-sub">RESIDENCE · REAL-TIME ARCHITECTURE</div></div>
    <div class="b51-floor-tag">1F · 独立入户大堂</div>
    <nav class="b51-floors" aria-label="楼层传送">${[1,2,3,4,5,6].map((n) => `<button data-floor="${n}" title="传送到${n}楼">${n}F</button>`).join('')}</nav>
    <div class="b51-actions"><button data-action="view" title="快捷键 V">第三人称</button><button data-action="help" title="快捷键 H">操作指南</button><button data-action="fullscreen">全屏</button></div>
    <div class="b51-status"><div class="b51-status-line"><span>探索状态</span><span data-status>就绪</span></div><div class="b51-bar"><i></i></div><div class="b51-status-line"><span>移动速度</span><span data-speed>0.0 m/s</span></div><div class="b51-bar blue"><i data-speedbar style="width:0%"></i></div><div class="b51-metrics" data-metrics>场景已加载</div></div>
    <div class="b51-hint">WASD 移动 · 鼠标环顾 · Shift 奔跑 · 空格跳跃 · V 视角 · 1–6 传送</div>
    <div class="b51-map"><canvas width="320" height="320" aria-label="当前楼层小地图"></canvas></div>
    <section class="b51-help" hidden><button class="close" data-action="help">关闭</button><h3>漫游操作指南</h3><p>WASD／方向键：移动　Shift：奔跑</p><p>拖拽：环顾　双击：锁定鼠标　Esc：释放</p><p>空格：跳跃　滚轮：镜头距离　V：第一／第三人称</p><p>数字 1–6 或右上楼层按钮：电梯式快速到达</p><p>触屏：左侧摇杆移动，右侧区域滑动环顾</p><p>楼梯使用平滑碰撞坡面；镜头遇墙自动缩短。</p></section>
    <div class="b51-joystick"><div class="b51-stick"></div></div><button class="b51-run">奔跑</button><button class="b51-jump">跳跃</button><div class="b51-portrait">横屏体验更开阔</div>
    <div class="b51-toast" role="status"></div>
    <section class="b51-entry" hidden><div class="b51-card"><div class="b51-overline">BUILDING 51 · INTERACTIVE RESIDENCE</div><h1>3栋51#<br>建筑漫游</h1><p>走入真实户型，从一楼大堂到六楼美式轻奢公寓。二至五楼呈现黑白灰现代空间；六楼以奶白布艺、胡桃木与米白大理石营造温暖层次。</p><button class="b51-enter">点击进入</button><div class="b51-legend"><span>六层完整建筑</span><span>自由行走与碰撞</span><span>双端漫游</span></div></div></section>`
  container.append(root)
  const $ = (selector) => root.querySelector(selector)
  const $$ = (selector) => [...root.querySelectorAll(selector)]
  const on = (element, type, handler) => element.addEventListener(type, handler, { signal })
  const joystick = { x: 0, y: 0 }
  let currentFloor = 1, backend = '', toastTimer = 0, joyPointer = null
  const pad = $('.b51-joystick'), stick = $('.b51-stick')
  const map = $('.b51-map canvas'), ctx = map.getContext('2d')
  function moveJoy(event) {
    const rect = pad.getBoundingClientRect()
    let x = event.clientX - rect.left - rect.width / 2, y = event.clientY - rect.top - rect.height / 2
    const radius = rect.width * 0.32, length = Math.hypot(x, y)
    if (length > radius) { x *= radius / length; y *= radius / length }
    joystick.x = x / radius; joystick.y = y / radius
    stick.style.transform = `translate(${x}px,${y}px)`
  }
  on(pad, 'pointerdown', (event) => { joyPointer = event.pointerId; pad.setPointerCapture(event.pointerId); moveJoy(event); event.preventDefault() })
  on(pad, 'pointermove', (event) => { if (joyPointer === event.pointerId) moveJoy(event) })
  const resetJoy = () => { joyPointer = null; joystick.x = joystick.y = 0; stick.style.transform = '' }
  on(pad, 'pointerup', resetJoy); on(pad, 'pointercancel', resetJoy)
  for (const button of $$('[data-floor]')) on(button, 'click', () => callbacks.onFloor(Number(button.dataset.floor)))
  $('[data-action="view"]').onclick = callbacks.onView
  for (const button of $$('[data-action="help"]')) on(button, 'click', () => { $('.b51-help').hidden = !$('.b51-help').hidden; callbacks.onHelp() })
  on($('[data-action="fullscreen"]'), 'click', callbacks.onFullscreen)
  on($('.b51-enter'), 'click', () => { $('.b51-entry').hidden = true; callbacks.onStart() })
  on($('.b51-jump'), 'pointerdown', (event) => { event.preventDefault(); callbacks.onJump() })
  on($('.b51-run'), 'pointerdown', (event) => { event.preventDefault(); const on = $('.b51-run').classList.toggle('on'); callbacks.onRun(on) })

  function drawMap(position, yaw) {
    const W = 320, H = 320, scale = 13.3, ox = W / 2, oy = H / 2
    const X = (x) => ox + x * scale, Y = (z) => oy + z * scale
    ctx.clearRect(0, 0, W, H)
    ctx.fillStyle = '#15241e'; ctx.fillRect(0, 0, W, H)
    ctx.strokeStyle = '#90a596'; ctx.lineWidth = 2
    ctx.strokeRect(X(-8.6), Y(-7.45), 17.2 * scale, 14.9 * scale)
    ctx.fillStyle = '#81968722'; ctx.fillRect(X(-3.3), Y(2.6), 4 * scale, 4.85 * scale); ctx.fillRect(X(0.7), Y(2.6), 4 * scale, 4.85 * scale)
    ctx.strokeStyle = '#7a8c8255'; ctx.lineWidth = 1
    for (const x of [-3.3, 0.7, 4.7]) { ctx.beginPath(); ctx.moveTo(X(x), Y(-7.45)); ctx.lineTo(X(x), Y(7.45)); ctx.stroke() }
    for (const z of [-2.6, 2.6]) { ctx.beginPath(); ctx.moveTo(X(-8.6), Y(z)); ctx.lineTo(X(8.6), Y(z)); ctx.stroke() }
    ctx.fillStyle = '#bba27b66'; ctx.fillRect(X(-1.24), Y(-7.0), 2.48 * scale, 3.2 * scale)
    ctx.fillStyle = '#b8c5bc'; ctx.font = '18px sans-serif'; ctx.textAlign = 'center'
    ctx.fillText(currentFloor === 1 ? '入户大堂' : '左户', X(-4.8), Y(-0.3)); ctx.fillText(currentFloor === 1 ? '电梯厅' : '右户', X(5.5), Y(-0.3))
    ctx.fillStyle = '#bba27b'; ctx.font = '14px sans-serif'; ctx.fillText('楼梯', X(0), Y(-5.5)); ctx.fillText('N ↑', 293, 28)
    if (position) {
      const x = X(position.x), y = Y(position.z)
      ctx.save(); ctx.translate(x, y); ctx.rotate(-yaw)
      ctx.fillStyle = '#f5d6a0'; ctx.beginPath(); ctx.moveTo(0, -10); ctx.lineTo(6, 7); ctx.lineTo(0, 4); ctx.lineTo(-6, 7); ctx.closePath(); ctx.fill(); ctx.restore()
    }
    ctx.strokeStyle = '#ffffff20'; ctx.strokeRect(10, 10, 300, 300)
  }
  drawMap()
  return {
    joystick,
    setFloor(floor) {
      currentFloor = floor
      for (const button of $$('[data-floor]')) button.classList.toggle('active', Number(button.dataset.floor) === floor)
      $('.b51-floor-tag').textContent = `${floor}F · ${floor === 1 ? '独立入户大堂' : floor === 6 ? '美式轻奢 · 奶白布艺与大理石' : '现代简约 · 黑白灰空间'}`
      drawMap()
    },
    setBackend(value) { backend = value; $('.b51-metrics').textContent = `${backend} · 已就绪` },
    setView(view) { $('[data-action="view"]').textContent = view === 'third' ? '第三人称' : '第一人称' },
    showEntry(visible) { $('.b51-entry').hidden = !visible },
    toggleHelp() { $('.b51-help').hidden = !$('.b51-help').hidden },
    toast(text) { const el = $('.b51-toast'); el.textContent = text; el.classList.add('show'); clearTimeout(toastTimer); toastTimer = setTimeout(() => el.classList.remove('show'), 2200) },
    update(position, floor, stats) {
      $('[data-status]').textContent = stats.grounded ? (stats.speed > 0.2 ? '行走中' : '已落地') : '跳跃中'
      $('[data-speed]').textContent = `${stats.speed.toFixed(1)} m/s`
      $('[data-speedbar]').style.width = `${Math.min(100, stats.speed / 5.5 * 100)}%`
      $('[data-metrics]').textContent = `${backend} · ${stats.fps} FPS · ${stats.view === 'third' ? '第三人称' : '第一人称'}`
      drawMap(position, stats.yaw)
    },
    dispose() { clearTimeout(toastTimer); root.remove() },
  }
}

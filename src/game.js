// Plain browser code. No Edit3D gameplay API is needed.
export function playCube({ canvas, container, signal }, cube, settings) {
  const keys = new Set()
  let started = false,
    audio
  const begin = document.createElement('button')
  begin.textContent = '开始 · 方向键移动，点击画布发声'
  begin.style.cssText = 'position:absolute;top:20px;left:20px;padding:12px'
  container.append(begin)
  begin.addEventListener(
    'click',
    () => {
      // Audio is initialized in a real user gesture, not an asynchronous scene factory.
      audio ??= new AudioContext()
      void audio.resume()
      started = true
      begin.remove()
      canvas.focus()
    },
    { signal },
  )
  canvas.addEventListener(
    'keydown',
    (event) => {
      if (!event.code.startsWith('Arrow')) return
      event.preventDefault()
      keys.add(event.code)
    },
    { signal },
  )
  canvas.addEventListener('keyup', (event) => keys.delete(event.code), { signal })
  canvas.addEventListener('blur', () => keys.clear(), { signal })
  canvas.addEventListener(
    'pointerdown',
    () => {
      canvas.focus()
      if (!audio || !started) return
      const oscillator = audio.createOscillator(),
        gain = audio.createGain()
      oscillator.connect(gain)
      gain.connect(audio.destination)
      gain.gain.setValueAtTime(0.1, audio.currentTime)
      gain.gain.exponentialRampToValueAtTime(0.001, audio.currentTime + 0.15)
      oscillator.start()
      oscillator.stop(audio.currentTime + 0.15)
      oscillator.onended = () => {
        oscillator.disconnect()
        gain.disconnect()
      }
    },
    { signal },
  )
  return {
    update(dt) {
      if (!started) return
      cube.position.x += (Number(keys.has('ArrowRight')) - Number(keys.has('ArrowLeft'))) * settings.speed * dt
      cube.rotation.y += dt
    },
    dispose() {
      keys.clear()
      return audio?.close()
    },
  }
}

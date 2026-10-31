import { spawn } from 'node:child_process'
import { readFile, rm, writeFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'

const command = process.argv[2]
if (!['dev', 'build'].includes(command)) throw new Error('Usage: node tools/pages-vite.mjs dev|build [-- ...vite args]')

const root = fileURLToPath(new URL('../', import.meta.url))
const template = new URL('../pages/index.template', import.meta.url)
const entry = new URL('../pages/index.html', import.meta.url)
const vite = fileURLToPath(new URL('../node_modules/vite/bin/vite.js', import.meta.url))
let ownsEntry = false
let child
const signals = ['SIGINT', 'SIGTERM']
const handlers = signals.map((signal) => () => child?.kill(signal))

try {
  // Edit3D's own dev service scans every HTML entry below the project root and cannot
  // prebundle the standalone WebGPU renderer. Expose this entry only to this Vite process.
  const html = await readFile(template)
  await writeFile(entry, html, { flag: 'wx' })
  ownsEntry = true
  child = spawn(process.execPath, [vite, ...(command === 'dev' ? [] : ['build']), '--config', 'pages/vite.config.js', ...process.argv.slice(3)], {
    cwd: root,
    stdio: 'inherit',
    windowsHide: true,
  })
  signals.forEach((signal, index) => process.on(signal, handlers[index]))
  const code = await new Promise((resolve, reject) => {
    child.once('error', reject)
    child.once('exit', (value) => resolve(value ?? 1))
  })
  process.exitCode = code
} finally {
  signals.forEach((signal, index) => process.off(signal, handlers[index]))
  if (ownsEntry) await rm(entry, { force: true })
}

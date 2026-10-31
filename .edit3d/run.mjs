// 3D Editor plugin launcher. SDK/CLI are supplied by the installed plugin.
import { readFile } from 'node:fs/promises'
import { spawn } from 'node:child_process'
const config = JSON.parse(await readFile(new URL('./plugin.json', import.meta.url), 'utf8'))
const entry = process.env.KIMI_EDIT3D_PLUGIN_ENTRY || config.entry
const child = spawn(process.execPath, [entry, ...process.argv.slice(2)], { stdio: 'inherit', env: process.env })
child.on('error', (error) => { console.error('3D Editor plugin unavailable:', error.message); process.exitCode = 1 })
child.on('exit', (code) => { process.exitCode = code ?? 1 })
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => child.kill(signal))

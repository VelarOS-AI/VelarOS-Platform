import { spawnSync } from 'node:child_process'
import { mkdirSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

if (process.platform !== 'win32') throw new Error('Windows process host must be built on Windows')
const root = dirname(fileURLToPath(import.meta.url))
const output = resolve(process.argv[2] ?? resolve(root, `win32-${process.arch}`))
mkdirSync(output, { recursive: true })
const result = spawnSync('cl.exe', [
  '/nologo', '/std:c++17', '/EHsc', '/W4', '/WX', '/O2', '/MT', '/DUNICODE', '/D_UNICODE',
  `/Fe:${resolve(output, 'velaros-process-host.exe')}`,
  `/Fo:${resolve(output, 'windows-process-host.obj')}`,
  resolve(root, 'windows-process-host.cpp'),
], { cwd: output, stdio: 'inherit', timeout: 120_000, windowsHide: true })
if (result.error) throw result.error
if (result.status !== 0) throw new Error(`Windows process host build failed (${result.status})`)

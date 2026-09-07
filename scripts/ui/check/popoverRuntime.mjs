#!/usr/bin/env node
// Requires a fresh packages/ui build and an available desktop Electron runtime.
// Renderer sendInputEvent checks are not proof of OS-level draggable-region hit testing.
import { spawn } from 'node:child_process'
import { access, copyFile, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { build } from 'vite'

const here = dirname(fileURLToPath(import.meta.url))
const root = resolve(here, '../../..')
const require = createRequire(import.meta.url)
const directory = await mkdtemp(join(tmpdir(), 'velaros-ui-popover-runtime-'))
console.log(`Popover runtime artifacts: ${directory}`)
try {
  const popoverPath = join(root, 'packages/ui/dist/primitives/overlays/Popover.js')
  await access(popoverPath).catch(() => { throw new Error('Build UI first: bun run --cwd packages/ui build') })
  if (!(await readFile(popoverPath, 'utf8')).includes('onOpenAutoFocus')) throw new Error('UI dist is stale. Run bun run --cwd packages/ui build first.')
  await symlink(join(root, 'node_modules'), join(directory, 'node_modules'), process.platform === 'win32' ? 'junction' : 'dir')
  await copyFile(join(here, 'popoverRuntimeFixture.tsx'), join(directory, 'scene.tsx'))
  await writeFile(join(directory, 'fixture.css'), `:root{--background:#fff;--card:#fff;--popover:#fff;--foreground:#202020;--border:#e5e5e5;--border-strong:#ccc;--control-gray-bg:rgba(0,0,0,.06);--control-gray-hover-bg:rgba(0,0,0,.1)}body{margin:0;background:#fff;font-family:system-ui}#git{position:absolute;left:80px;top:20px;width:220px}#focus{position:absolute;left:500px;top:100px}#outside-focus{position:absolute;left:650px;top:440px}`)
  const globalStyles = [
    '@velaros-ai/ui/styles/tokens/design-tokens.css', '@velaros-ai/ui/styles/components/index.css',
    '@velaros-ai/ui/styles/components/product.css', './fixture.css',
  ].map((specifier) => `import ${JSON.stringify(specifier)}`).join('\n')
  for (const mode of ['eager', 'lazy']) {
    await writeFile(join(directory, `${mode}.tsx`), mode === 'eager'
      ? `import {mount} from './scene'\n${globalStyles}\nmount()`
      : `${globalStyles}\nimport('./scene').then(({mount})=>mount())`)
    await writeFile(join(directory, `${mode}.html`), `<html><body><div id="root"></div><script type="module" src="./${mode}.tsx"></script></body></html>`)
    await build({ configFile: false, root: directory, base: './', publicDir: false, logLevel: 'warn',
      build: { outDir: join(directory, mode), emptyOutDir: true, rollupOptions: { input: join(directory, `${mode}.html`) } } })
  }
  const environment = { ...process.env }
  delete environment.ELECTRON_RUN_AS_NODE
  const child = spawn(require('electron'), [join(here, 'popoverRuntimeElectron.cjs'), directory], {
    env: environment, stdio: 'inherit', detached: process.platform !== 'win32',
  })
  const stop = () => {
    if (child.exitCode !== null || child.signalCode !== null) return
    try { process.platform === 'win32' ? child.kill('SIGKILL') : process.kill(-child.pid, 'SIGKILL') } catch {}
  }
  const timer = setTimeout(stop, 90_000)
  const interrupt = () => { stop(); process.exitCode = 1 }
  process.once('SIGINT', interrupt)
  process.once('SIGTERM', interrupt)
  try {
    const code = await new Promise((resolveExit, reject) => {
      child.once('error', reject)
      child.once('exit', (exitCode) => resolveExit(exitCode))
    })
    if (code !== 0) throw new Error(`Popover runtime failed (exit ${code}). Inspect ${join(directory, 'report.json')}`)
  } finally {
    clearTimeout(timer)
    process.removeListener('SIGINT', interrupt)
    process.removeListener('SIGTERM', interrupt)
    stop()
  }
} finally {
  await rm(join(directory, 'user-data'), { recursive: true, force: true })
  await rm(join(directory, 'node_modules'), { recursive: true, force: true })
}

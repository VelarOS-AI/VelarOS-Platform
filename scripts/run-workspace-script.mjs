#!/usr/bin/env node
// 用途：按 buildPackageTopology 的拓扑序对每个 workspace 包依次跑同名 script（如 typecheck），
// 任一失败即退出非零。顺序执行、输出不交错，替代 bun run --filter 的并行噪音。
import { spawn, spawnSync } from 'node:child_process'
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url))
const ROOT_DIR = resolve(SCRIPT_DIR, '..')
const PACKAGES_DIR = resolve(ROOT_DIR, 'packages')

const scriptName = process.argv[2]
if (!scriptName) {
  console.error('用法：node scripts/run-workspace-script.mjs <script-name>')
  process.exit(2)
}

// Workspace packages are flat: every package lives at packages/<package>/.
function listPackageDirectories() {
  const found = []
  for (const entry of readdirSync(PACKAGES_DIR, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue
    if (existsSync(resolve(PACKAGES_DIR, entry.name, 'package.json'))) found.push(entry.name)
  }
  return found.sort((a, b) => a.localeCompare(b))
}

const reportDirectory = resolve(ROOT_DIR, '.velaros-workspace', 'checks')
mkdirSync(reportDirectory, { recursive: true })
const reportPath = resolve(
  reportDirectory,
  `${scriptName.replaceAll(':', '-')}-${process.pid}.jsonl`
)
console.log(`检查计时回执：${reportPath}`)
const jobs = listPackageDirectories().flatMap((directory) => {
  const dir = resolve(PACKAGES_DIR, directory)
  const manifest = JSON.parse(readFileSync(resolve(dir, 'package.json'), 'utf8'))
  if (!manifest.scripts?.[scriptName]) return []
  return [{ dir, name: manifest.name }]
})
let failed = false
let cursor = 0
// 只有无产物写入的类型检查并行；构建和测试仍保持原顺序。
const concurrency = scriptName === 'typecheck' ? 2 : 1
async function worker() {
  while (cursor < jobs.length) {
    const job = jobs[cursor++]
    console.log(`▸ ${scriptName} ${job.name}`)
    const started = performance.now()
    const result =
      scriptName === 'typecheck'
        ? await new Promise((resolveResult) => {
            const child = spawn('bun', ['run', scriptName], {
              cwd: job.dir,
              env: process.env,
              stdio: ['ignore', 'pipe', 'pipe'],
            })
            let output = ''
            child.stdout.on('data', (chunk) => {
              output += chunk
            })
            child.stderr.on('data', (chunk) => {
              output += chunk
            })
            child.once('error', (error) => resolveResult({ status: null, error, output }))
            child.once('close', (status, signal) => resolveResult({ status, signal, output }))
          })
        : spawnSync('bun', ['run', scriptName], {
            cwd: job.dir,
            env: process.env,
            stdio: 'inherit',
          })
    const durationMs = Math.round(performance.now() - started)
    const receipt = {
      package: job.name,
      script: scriptName,
      durationMs,
      exitCode: result.status,
      signal: result.signal,
      error: result.error?.message,
    }
    appendFileSync(reportPath, `${JSON.stringify(receipt)}\n`)
    if (result.output) {
      appendFileSync(`${reportPath}.log`, `\n=== ${job.name} ===\n${result.output}`)
      if (result.status !== 0) console.error(result.output)
    }
    console.log(`▸ ${job.name} ${scriptName}: ${durationMs}ms, exit=${result.status}`)
    if (result.status !== 0) failed = true
  }
}
await Promise.all(Array.from({ length: concurrency }, () => worker()))
process.exitCode = failed ? 1 : 0

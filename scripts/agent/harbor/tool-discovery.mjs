import { opendir } from 'node:fs/promises'
import { join } from 'node:path'

// 仅按配置文件名选择待探测命令；不执行配置、不跟随链接、不读取项目正文。
const markers = new Map([
  ['go.mod', ['go', 'gofmt']],
  ['go.work', ['go', 'gofmt']],
  ['package.json', ['node', 'npm']],
  ['pnpm-lock.yaml', ['node', 'pnpm']],
  ['pnpm-workspace.yaml', ['node', 'pnpm']],
  ['yarn.lock', ['node', 'yarn']],
  ['bun.lock', ['bun']],
  ['bun.lockb', ['bun']],
  ['pyproject.toml', ['python3', 'uv']],
  ['setup.py', ['python3']],
  ['setup.cfg', ['python3']],
  ['Pipfile', ['python3', 'pipenv']],
  ['Cargo.toml', ['cargo', 'rustc']],
  ['pom.xml', ['java', 'mvn']],
  ['build.gradle', ['java', 'gradle']],
  ['build.gradle.kts', ['java', 'gradle']],
])
const excluded = new Set([
  '.git',
  'node_modules',
  'vendor',
  '.venv',
  'venv',
  'dist',
  'build',
  'target',
])

export async function discoverProjectCommands(
  workspace,
  { maxDepth = 3, maxDirectories = 32, maxEntries = 2048 } = {}
) {
  const commands = new Set(['git', 'rg'])
  const pending = [{ path: workspace, depth: 0 }]
  const coverage = {
    exhaustive: false,
    maxDepth,
    maxDirectories,
    maxEntries,
    directories: 0,
    entries: 0,
    limited: false,
    unreadable: 0,
  }
  for (let cursor = 0; cursor < pending.length; cursor++) {
    if (coverage.directories >= maxDirectories || coverage.entries >= maxEntries) {
      coverage.limited = true
      break
    }
    const { path, depth } = pending[cursor]
    let directory
    try {
      directory = await opendir(path)
    } catch {
      coverage.unreadable++
      continue
    }
    coverage.directories++
    for await (const entry of directory) {
      coverage.entries++
      if (entry.isFile()) {
        const names =
          markers.get(entry.name) ??
          (/^requirements(?:[-.][\w.-]+)?\.txt$/i.test(entry.name) ? ['python3'] : [])
        for (const name of names) commands.add(name)
      } else if (entry.isDirectory() && !excluded.has(entry.name)) {
        if (depth < maxDepth && pending.length < maxDirectories)
          pending.push({ path: join(path, entry.name), depth: depth + 1 })
        else coverage.limited = true
      }
      if (coverage.entries >= maxEntries) {
        coverage.limited = true
        break
      }
    }
  }
  return { commands: [...commands].sort(), coverage }
}

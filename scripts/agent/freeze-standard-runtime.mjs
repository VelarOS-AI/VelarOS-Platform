#!/usr/bin/env node
// 从指定 checkout 保存独立包快照；工作区包重定向到快照，外部依赖保持精确安装版本。
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { cp, mkdir, readdir, readFile, realpath, symlink, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'

const source = resolve(process.argv[2] ?? '.')
const destination = resolve(process.argv[3])
const sourceCommit = execFileSync('git', ['rev-parse', 'HEAD'], {
  cwd: source,
  encoding: 'utf8',
}).trim()
const sourceDirty = Boolean(
  execFileSync('git', ['status', '--porcelain'], { cwd: source, encoding: 'utf8' }).trim()
)
assert.match(sourceCommit, /^[0-9a-f]{40,64}$/u)
await mkdir(destination)
const packages = new Map()
for (const directory of await readdir(join(source, 'packages'), { withFileTypes: true })) {
  if (!directory.isDirectory()) continue
  const from = join(source, 'packages', directory.name)
  const manifest = JSON.parse(await readFile(join(from, 'package.json'), 'utf8'))
  const target = join(destination, 'packages', directory.name)
  packages.set(manifest.name, target)
  await cp(from, target, {
    recursive: true,
    filter: (path) =>
      !path.split('/').some((part) => ['node_modules', 'test', 'tests', 'spec'].includes(part)) &&
      !path.endsWith('.tsbuildinfo'),
  })
}
async function linkModules(from, to, manifest) {
  const declared = new Set(
    Object.keys({
      ...manifest.dependencies,
      ...manifest.devDependencies,
      ...manifest.optionalDependencies,
    })
  )
  const entries = await readdir(from, { withFileTypes: true }).catch((error) => {
    if (error.code === 'ENOENT') return []
    throw error
  })
  for (const entry of entries) {
    if (entry.name.startsWith('.')) continue
    const names = entry.name.startsWith('@')
      ? (await readdir(join(from, entry.name))).map((name) => `${entry.name}/${name}`)
      : [entry.name]
    for (const name of names) {
      if (!declared.has(name)) continue
      const target = packages.get(name) ?? (await realpath(join(from, name)))
      const output = join(to, name)
      await mkdir(resolve(output, '..'), { recursive: true })
      await symlink(target, output)
    }
  }
}
for (const [name, target] of packages) {
  const local = join(destination, 'node_modules', name)
  await mkdir(resolve(local, '..'), { recursive: true })
  await symlink(target, local)
  const manifest = JSON.parse(await readFile(join(target, 'package.json'), 'utf8'))
  await linkModules(
    join(source, 'packages', target.split('/').at(-1), 'node_modules'),
    join(target, 'node_modules'),
    manifest
  )
}
const files = {}
async function hash(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (entry.name === 'node_modules') continue
    const path = join(directory, entry.name)
    if (entry.isDirectory()) await hash(path)
    else if (entry.isFile())
      files[path.slice(destination.length + 1)] = createHash('sha256')
        .update(await readFile(path))
        .digest('hex')
  }
}
await hash(join(destination, 'packages'))
assert.ok(Object.keys(files).length)
await writeFile(
  join(destination, 'manifest.json'),
  JSON.stringify(
    { source, sourceCommit, sourceDirty, createdAt: new Date().toISOString(), files },
    null,
    2
  )
)
console.log(JSON.stringify({ snapshot: destination, files: Object.keys(files).length }))

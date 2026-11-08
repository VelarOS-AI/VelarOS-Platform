// 用途：通过真实 Git 清单核对 Unicode、空格和未跟踪文件不会逃过语法树检查。
import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { copyFileSync, mkdirSync, mkdtempSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

const repositoryRoot = fileURLToPath(new URL('../../', import.meta.url))
const temporaryRoot = join(repositoryRoot, '.velaros-workspace')

function fixture(t) {
  mkdirSync(temporaryRoot, { recursive: true })
  const root = mkdtempSync(join(temporaryRoot, 'error-construction-'))
  t.after(() => {
    assert.equal(dirname(resolve(root)), resolve(temporaryRoot))
    rmSync(root, { recursive: true, force: true })
  })
  const write = (path, source) => {
    const absolute = join(root, path)
    mkdirSync(dirname(absolute), { recursive: true })
    writeFileSync(absolute, source)
  }
  write('packages/core/src/error.ts', 'export const original = new Error("core owns errors")')
  write(
    'packages/script/src/utils/output-capture.ts',
    'export const isolated = new Error("injected")'
  )
  const runner = join(root, 'scripts/quality/check-error-construction.mjs')
  mkdirSync(dirname(runner), { recursive: true })
  copyFileSync(new URL('./check-error-construction.mjs', import.meta.url), runner)
  const git = (...args) =>
    execFileSync('git', args, { cwd: root, stdio: 'pipe', windowsHide: true })
  git('init', '--quiet')
  git('config', 'core.quotepath', 'true')
  const run = () =>
    spawnSync(process.execPath, [runner], {
      cwd: root,
      encoding: 'utf8',
      timeout: 10_000,
      windowsHide: true,
      env: { ...process.env, GIT_CEILING_DIRECTORIES: temporaryRoot },
    })
  return { root, write, git, run }
}

test('tracked and untracked Unicode names and spaces retain their actual Git path', (t) => {
  const f = fixture(t)
  const tracked = ['packages/example/引擎.ts', 'packages/example/with space.ts']
  for (const path of tracked) f.write(path, 'export const failure = new Error("actual error")')
  f.git('add', '--', '.')
  const untracked = 'packages/example/待检.ts'
  f.write(untracked, 'export const failure = Error("actual call")')
  const result = f.run()
  assert.equal(result.error, undefined)
  assert.equal(result.status, 1, result.stdout + result.stderr)
  assert.match(result.stderr, /失败：3 处/)
  for (const path of [...tracked, untracked])
    assert.ok(result.stderr.includes(`${path}:1:`), result.stderr)
  for (const path of [...tracked, untracked])
    f.write(path, 'export const text = "new Error(does not execute)" // Error("comment")')
  const clean = f.run()
  assert.equal(clean.error, undefined)
  assert.equal(clean.status, 0, clean.stdout + clean.stderr)
})

test('real Git failure cannot report an empty successful inventory', (t) => {
  const f = fixture(t)
  renameSync(join(f.root, '.git'), join(f.root, 'git-not-active'))
  const result = f.run()
  assert.equal(result.error, undefined)
  assert.notEqual(result.status, 0)
  assert.match(result.stderr, /not a git repository/)
  assert.ok(!result.stdout.includes('[error-construction] 通过'))
})

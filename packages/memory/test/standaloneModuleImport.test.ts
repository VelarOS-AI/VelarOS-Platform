// 每个源文件都能在全新进程里单独加载：package.json 的每个入口与 src 下每个源文件各起一个 bun 进程只 import 它，不许报错。
// 去 barrel 之前，包内互相经 `./memory-tree`、`./knowledge/domain` 等中间转发绕回来，模块图里带环；单独 import 环上的
// 文件会在初始化时撞上「Cannot access … before initialization」（TDZ），只因为消费方总先 import 包根才没炸出来。
// 探针（`*-probe.ts`）是可执行脚本不是模块，import 就会跑断言、其中几个还要 Electron 的原生 SQLite，不在这条检查里。
import { spawn } from 'node:child_process'
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { availableParallelism } from 'node:os'
import { join, relative, resolve } from 'node:path'

import { describe, expect, test } from 'bun:test'

const PackageRoot = resolve(import.meta.dir, '..')
const SourceRoot = join(PackageRoot, 'src')
/** 单个文件单独加载的时限；正常几百毫秒。 */
const ImportTimeoutMs = 30_000
/** 整条检查的时限：一百多个文件，按并发数分批跑。 */
const SuiteTimeoutMs = 240_000
const Concurrency = Math.max(2, Math.min(8, availableParallelism()))

/** src 下全部源文件（不含 .d.ts 与探针脚本）。 */
function sourceFiles(directory: string): string[] {
  return readdirSync(directory).flatMap((entry) => {
    const path = join(directory, entry)
    if (statSync(path).isDirectory()) return sourceFiles(path)
    if (!entry.endsWith('.ts') || entry.endsWith('.d.ts')) return []
    return entry.endsWith('-probe.ts') ? [] : [path]
  })
}

/** package.json exports 每个入口在 src 里对应的源文件（dist/x.js → src/x.ts）。 */
function entrySources(): Map<string, string> {
  const manifest = JSON.parse(readFileSync(join(PackageRoot, 'package.json'), 'utf8')) as {
    exports: Record<string, { import: string }>
  }
  return new Map(Object.entries(manifest.exports).map(([subpath, target]) => [
    subpath,
    join(PackageRoot, target.import.replace(/^\.\/dist\//u, 'src/').replace(/\.js$/u, '.ts')),
  ]))
}

/** 报错输出里第一行像错误说明的内容。 */
function firstErrorLine(stderr: string): string {
  return stderr.split('\n').find((line) => /Error|error:/u.test(line))?.trim() ?? stderr.trim().split('\n')[0] ?? ''
}

/** 在全新的 bun 进程里只 import 这一个文件；成功返回 null，失败返回说明。 */
function importAlone(file: string): Promise<string | null> {
  return new Promise((done) => {
    const child = spawn(process.execPath, ['-e', `await import(${JSON.stringify(file)})`], {
      cwd: PackageRoot,
      stdio: ['ignore', 'ignore', 'pipe'],
    })
    let stderr = ''
    child.stderr.on('data', (chunk) => {
      stderr += String(chunk)
    })
    const timer = setTimeout(() => child.kill('SIGKILL'), ImportTimeoutMs)
    child.on('close', (code, signal) => {
      clearTimeout(timer)
      done(code === 0 ? null : `${relative(PackageRoot, file)}：${signal ?? `退出码 ${code}`} ${firstErrorLine(stderr)}`)
    })
  })
}

/** 按并发数分批单独加载全部文件，收集失败说明。 */
async function importEachAlone(files: readonly string[]): Promise<string[]> {
  const failures: string[] = []
  let next = 0
  const worker = async (): Promise<void> => {
    while (next < files.length) {
      const file = files[next]!
      next += 1
      const failure = await importAlone(file)
      if (failure) failures.push(failure)
    }
  }
  await Promise.all(Array.from({ length: Concurrency }, worker))
  return failures.sort()
}

describe('每个源文件都能单独加载', () => {
  test('package.json 的每个入口都对应 src 里的一个源文件', () => {
    const entries = entrySources()
    expect(entries.size).toBeGreaterThan(0)
    expect([...entries].filter(([, file]) => !existsSync(file)).map(([subpath]) => subpath)).toEqual([])
  })

  test('入口与 src 下每个源文件各在全新进程里单独 import 都不报错', async () => {
    const files = sourceFiles(SourceRoot).sort()
    for (const entry of entrySources().values()) expect(files).toContain(entry)
    expect(await importEachAlone(files)).toEqual([])
  }, SuiteTimeoutMs)
})

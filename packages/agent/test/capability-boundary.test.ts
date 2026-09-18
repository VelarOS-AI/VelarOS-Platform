import {
  readdirSync,
  readFileSync,
} from 'node:fs'
import {
  join,
  resolve,
} from 'node:path'

import {
  describe,
  expect,
  test,
} from 'bun:test'

const PackageRoot = resolve(import.meta.dir, '..')
// 执行循环不碰能力的实现：能力单元（含它们的本机实现）都由宿主装进空间、经端口注入。
const ForbiddenDependency = '@velaros-ai/velar'
// 只拦真正的引用（import、动态 import、require）；说明里指路写出包名不算依赖。
const ForbiddenImport = /(?:from\s+|import\s*\(|require\()\s*['"]@velaros-ai\/velar(?:\/[^'"]*)?['"]/u

function listTypeScriptFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name)
    if (entry.isDirectory()) return listTypeScriptFiles(path)
    return entry.name.endsWith('.ts') ? [path] : []
  })
}

describe('Agent capability boundary', () => {
  test('Agent has no dependency on the capability units', () => {
    const packageJson = JSON.parse(
      readFileSync(join(PackageRoot, 'package.json'), 'utf8')
    ) as { dependencies?: Record<string, string> }
    expect(packageJson.dependencies?.[ForbiddenDependency]).toBeUndefined()

    const offenders = listTypeScriptFiles(join(PackageRoot, 'src')).filter((path) =>
      ForbiddenImport.test(readFileSync(path, 'utf8'))
    )
    expect(offenders).toEqual([])
  })
})

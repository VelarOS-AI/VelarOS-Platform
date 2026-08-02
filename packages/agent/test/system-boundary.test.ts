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
const ForbiddenDependency = '@velaros-ai/system'

function listTypeScriptFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name)
    if (entry.isDirectory()) return listTypeScriptFiles(path)
    return entry.name.endsWith('.ts') ? [path] : []
  })
}

describe('Agent System boundary', () => {
  test('agent-runtime has no concrete System package dependency', () => {
    const packageJson = JSON.parse(
      readFileSync(join(PackageRoot, 'package.json'), 'utf8')
    ) as { dependencies?: Record<string, string> }
    expect(packageJson.dependencies?.[ForbiddenDependency]).toBeUndefined()

    const offenders = listTypeScriptFiles(join(PackageRoot, 'src')).filter((path) =>
      readFileSync(path, 'utf8').includes(ForbiddenDependency)
    )
    expect(offenders).toEqual([])
  })
})

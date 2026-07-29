import {
  readdirSync,
  readFileSync,
} from 'node:fs'
import {
  relative,
  resolve,
} from 'node:path'

import {
  describe,
  expect,
  test,
} from 'bun:test'

import {
  workspaceKernelTools,
  wsTool,
} from '../../src/agent-runtime'

const PackageRoot = resolve(import.meta.dir, '../..')
const SourceRoot = resolve(PackageRoot, 'src/agent-runtime')
const PackageManifest = JSON.parse(
  readFileSync(resolve(PackageRoot, 'package.json'), 'utf8'),
) as Record<string, Record<string, string> | undefined>
const ForbiddenHostImport =
  /(?:from\s+|import\s*\()\s*['"](?:electron(?:\/[^'"]*)?|@electron\/[^'"]*|@velaros\/ipc(?:\/[^'"]*)?|@(?:components|features|hooks|pages|styles|shared)\/[^'"]*|@\/[^'"]*|@preload|@main\/[^'"]*)['"]/
const ForbiddenCapabilityImport =
  /(?:from\s+|import\s*\()\s*['"]@velaros-ai\/(?:browser-[^'"]*|memory|knowledge|computer-runtime|computer-tools|system-tools|office-tools|model-runtime|kernel-host|kernel-service)(?:\/[^'"]*)?['"]/

function listTypeScriptFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = resolve(directory, entry.name)
    if (entry.isDirectory()) return listTypeScriptFiles(path)
    return entry.name.endsWith('.ts') ? [path] : []
  })
}

describe('Workspace Agent tools boundary', () => {
  test('Workspace owns its Agent contracts without Agent Runtime dependency', () => {
    for (const section of [
      'dependencies',
      'devDependencies',
      'peerDependencies',
      'optionalDependencies',
    ]) {
      expect(PackageManifest[section]?.['@velaros-ai/agent-runtime']).toBeUndefined()
    }
  })

  test('package remains host-agnostic and capability-focused', () => {
    const violations = listTypeScriptFiles(SourceRoot).flatMap((path) => {
      const source = readFileSync(path, 'utf8')
      return ForbiddenHostImport.test(source) || ForbiddenCapabilityImport.test(source)
        ? [relative(SourceRoot, path)]
        : []
    })

    expect(violations).toEqual([])
    expect(
      listTypeScriptFiles(SourceRoot).some((path) =>
        /\b(?:desktop|Desktop)\b/.test(readFileSync(path, 'utf8'))
      )
    ).toBe(false)
  })

  test('Workspace root inventory belongs to the Workspace port', () => {
    const typesSource = readFileSync(resolve(SourceRoot, 'Types.ts'), 'utf8')
    const helpersSource = readFileSync(resolve(SourceRoot, 'Helpers.ts'), 'utf8')
    const executeSource = readFileSync(resolve(SourceRoot, 'Execute.ts'), 'utf8')

    expect(typesSource).toContain('listRoots: () => WorkspaceToolRoot[]')
    expect(typesSource).not.toContain('listWorkspaceRoots')
    expect(helpersSource).toContain('ctx.workspace.listRoots()')
    expect(executeSource).toContain('.listRoots()')
  })

  test('public Workspace tool names remain stable', () => {
    expect(Object.keys(workspaceKernelTools).sort()).toEqual([
      wsTool.diff,
      wsTool.edit,
      wsTool.listFiles,
      wsTool.read,
      wsTool.rollback,
      wsTool.search,
      wsTool.stat,
      wsTool.symbols,
    ].sort())
  })
})

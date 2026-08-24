import { readdirSync, readFileSync } from 'node:fs'
import { relative, resolve } from 'node:path'

import { describe, expect, test } from 'bun:test'

import { projectTools } from '../../src/agent'
import { ProjectToolNames } from '../../src/project-tool-names'

const PackageRoot = resolve(import.meta.dir, '../..')
const SourceRoot = resolve(PackageRoot, 'src/agent')
const PackageManifest = JSON.parse(
  readFileSync(resolve(PackageRoot, 'package.json'), 'utf8'),
) as Record<string, Record<string, string> | undefined>
const ForbiddenHostImport =
  /(?:from\s+|import\s*\()\s*['"](?:electron(?:\/[^'"]*)?|@electron\/[^'"]*|@velaros\/ipc(?:\/[^'"]*)?|@(?:components|features|hooks|pages|styles|shared)\/[^'"]*|@\/[^'"]*|@preload|@main\/[^'"]*)['"]/
const ForbiddenCapabilityImport =
  /(?:from\s+|import\s*\()\s*['"]@velaros-ai\/(?:browser(?:\/[^'"]*)?|memory|knowledge|computer(?:\/[^'"]*)?|system(?:\/[^'"]*)?|office|model(?:\/[^'"]*)?)(?:\/[^'"]*)?['"]/

function listTypeScriptFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = resolve(directory, entry.name)
    if (entry.isDirectory()) return listTypeScriptFiles(path)
    return entry.name.endsWith('.ts') ? [path] : []
  })
}

describe('Project Agent boundary', () => {
  test('depends on the grouped Agent package through explicit subpaths', () => {
    expect(PackageManifest.dependencies?.['@velaros-ai/agent']).toBe('workspace:*')
    for (const path of listTypeScriptFiles(SourceRoot)) {
      const source = readFileSync(path, 'utf8')
      expect(source).not.toMatch(/from ['"]@velaros-ai\/agent['"]/)
    }
  })

  test('remains host-agnostic and capability-focused', () => {
    const violations = listTypeScriptFiles(SourceRoot).flatMap((path) => {
      const source = readFileSync(path, 'utf8')
      return ForbiddenHostImport.test(source) || ForbiddenCapabilityImport.test(source)
        ? [relative(SourceRoot, path)]
        : []
    })
    expect(violations).toEqual([])
  })

  test('tool context exposes only the ports used by the Project tool surface', () => {
    const source = readFileSync(resolve(SourceRoot, 'Types.ts'), 'utf8')
    for (const field of [
      'getRootPath',
      'runInDirectory',
      'kernel',
      'runWithApproval',
      'prepareMutation',
      'runCommand',
      'queryCode',
    ]) expect(source).toContain(field)
    for (const removedField of [
      'codingSession',
      'projectSandbox',
      'listRoots',
      'kernelForRoot',
    ]) expect(source).not.toContain(removedField)
  })

  test('publishes exactly the canonical Project tool surface', () => {
    expect(Object.keys(projectTools)).toEqual(Object.values(ProjectToolNames))
  })
})

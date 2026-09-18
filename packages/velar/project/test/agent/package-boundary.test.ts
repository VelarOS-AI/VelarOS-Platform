import { readdirSync, readFileSync } from 'node:fs'
import { relative, resolve } from 'node:path'

import { describe, expect, test } from 'bun:test'

/** 项目单元的源码根：单元目录本身，spec/ 与 test/ 不算源码。 */
const SourceRoot = resolve(import.meta.dir, '../..')
const PackageManifest = JSON.parse(
  readFileSync(resolve(SourceRoot, '../package.json'), 'utf8'),
) as Record<string, Record<string, string> | undefined>
const ForbiddenHostImport =
  /(?:from\s+|import\s*\()\s*['"](?:electron(?:\/[^'"]*)?|@electron\/[^'"]*|@velaros\/ipc(?:\/[^'"]*)?|@(?:components|features|hooks|pages|styles|shared)\/[^'"]*|@\/[^'"]*|@preload|@main\/[^'"]*)['"]/
const ForbiddenCapabilityImport =
  /(?:from\s+|import\s*\()\s*['"]@velaros-ai\/(?:browser(?:\/[^'"]*)?|memory|knowledge|computer(?:\/[^'"]*)?|system(?:\/[^'"]*)?|office|model(?:\/[^'"]*)?)(?:\/[^'"]*)?['"]/

function listTypeScriptFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = resolve(directory, entry.name)
    if (entry.isDirectory()) return directory === SourceRoot && ['spec', 'test'].includes(entry.name) ? [] : listTypeScriptFiles(path)
    return entry.name.endsWith('.ts') ? [path] : []
  })
}

describe('项目工具的边界', () => {
  test('depends on the grouped Agent package through explicit subpaths', () => {
    expect(PackageManifest.peerDependencies?.['@velaros-ai/agent']).toBe('workspace:^')
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

  test('空间端口只留两件工具真会调的方法', () => {
    const source = readFileSync(resolve(SourceRoot, 'contract/requires.ts'), 'utf8')
    const port = source.slice(source.indexOf('export interface ProjectSpacePort'), source.indexOf('export interface ProjectOperationContext'))
    for (const field of ['getRootPath', 'kernel', 'queryCode']) expect(port).toContain(`${field}:`)
    // 命令、沙箱、缩图是空间给共用能力装端口时才要的，在 @velaros-ai/project 的宿主端口上，工具这边不留。
    for (const removedField of ['prepareMutation', 'runCommand', 'listBackgroundTasks', 'refreshShellEnvironment', 'sandbox', 'resizeImage', 'runInDirectory', 'runWithApproval', 'codingSession', 'listRoots', 'kernelForRoot']) {
      expect(port).not.toContain(`${removedField}:`)
    }
  })
})

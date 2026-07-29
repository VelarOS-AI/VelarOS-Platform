import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'

import { describe, expect, test } from 'bun:test'

const CoreRoot = resolve(import.meta.dir, '..')

describe('@velaros-ai/core boundary', () => {
  test('does not ship concrete capability contract files', () => {
    const forbiddenFiles = [
      'src/types/workspace.ts',
      'src/types/knowledge.ts',
      'src/types/workbench.ts',
      'src/types/externalAgentBridge.ts',
      'src/constants/workspaceSpaces.ts',
      'src/constants/workspaceToolNames.ts',
      'src/constants/modelCatalog.ts',
      'src/constants/modelProviderManifest.ts',
      'src/constants/runProfiles.ts',
      'src/constants/toolSurfaceProfiles.ts',
    ]

    expect(forbiddenFiles.filter((file) => existsSync(resolve(CoreRoot, file)))).toEqual([])
  })

  test('public entry does not re-export concrete capability modules', () => {
    const entry = readFileSync(resolve(CoreRoot, 'src/index.ts'), 'utf8').toLowerCase()
    for (const domain of ['workspace', 'knowledge', 'workbench', 'browser', 'memory']) {
      expect(entry).not.toContain(`./${domain}`)
    }
  })
})

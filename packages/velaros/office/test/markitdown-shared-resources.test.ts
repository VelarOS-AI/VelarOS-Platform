import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, test } from 'bun:test'

import { velarosSharedResources } from '@velaros-ai/core/platform/shared-resources'

import { createMarkItDownLocator } from '../index'

let restoreSharedDataRoot: Nullable<string | undefined> = null
let createdRoot: Nullable<string> = null

afterEach(async () => {
  if (restoreSharedDataRoot !== null) {
    if (restoreSharedDataRoot === undefined) delete process.env.VELAROS_SHARED_DATA_ROOT
    else process.env.VELAROS_SHARED_DATA_ROOT = restoreSharedDataRoot
    restoreSharedDataRoot = null
  }
  if (createdRoot) {
    await rm(createdRoot, { recursive: true, force: true })
    createdRoot = null
  }
})

describe('MarkItDown 定位的共享资源根', () => {
  test('不经宿主登记也能发现装在 VelarOS 共享资源根里的插件', async () => {
    restoreSharedDataRoot = process.env.VELAROS_SHARED_DATA_ROOT
    const dataRoot = await mkdtemp(join(tmpdir(), 'velaros-office-shared-'))
    createdRoot = dataRoot
    process.env.VELAROS_SHARED_DATA_ROOT = dataRoot

    const packageRoot = join(
      velarosSharedResources.resourcesRoot(),
      'markitdown',
      `markitdown-${process.platform}-${process.arch}`
    )
    await mkdir(join(packageRoot, 'bin'), { recursive: true })
    await writeFile(join(packageRoot, 'package.json'), JSON.stringify({ version: '9.9.9' }))
    for (const name of ['markitdown', 'markitdown.cmd', 'markitdown.exe']) {
      await writeFile(join(packageRoot, 'bin', name), '')
      await chmod(join(packageRoot, 'bin', name), 0o755)
    }

    // 不给任何 resourceRoots、也不往登记表里登记：宿主把安装根登记在自己的表里时本包看不到，
    // 共享资源根属于平台约定，必须由本包自己算出来。
    const resolved = createMarkItDownLocator().resolve()
    expect(resolved?.packageRoot).toBe(packageRoot)
    expect(resolved?.version).toBe('9.9.9')
  })
})

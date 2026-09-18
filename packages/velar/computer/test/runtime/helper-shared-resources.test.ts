import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, test } from 'bun:test'

import { velarosSharedResources } from '@velaros-ai/platform/shared-resources'

import { createComputerHelperLocator } from '../../index'

const HelperScriptNames: Partial<Record<NodeJS.Platform, string>> = {
  darwin: 'mac_helper.py',
  linux: 'linux_helper.py',
  win32: 'win_helper.py',
}

const scriptName = HelperScriptNames[process.platform]
const supportedTest = scriptName ? test : test.skip

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

describe('helper 定位的共享资源根', () => {
  supportedTest('不经宿主登记也能发现装在 VelarOS 共享资源根里的插件', async () => {
    restoreSharedDataRoot = process.env.VELAROS_SHARED_DATA_ROOT
    const dataRoot = await mkdtemp(join(tmpdir(), 'velaros-computer-shared-'))
    createdRoot = dataRoot
    process.env.VELAROS_SHARED_DATA_ROOT = dataRoot

    const packageRoot = join(
      velarosSharedResources.resourcesRoot(),
      'computer-use',
      `computeruse-${process.platform}-${process.arch}`
    )
    const venvPython =
      process.platform === 'win32'
        ? join(packageRoot, 'venv', 'Scripts', 'python.exe')
        : join(packageRoot, 'venv', 'bin', 'python')
    await mkdir(join(packageRoot, 'venv', process.platform === 'win32' ? 'Scripts' : 'bin'), {
      recursive: true,
    })
    await writeFile(venvPython, '')
    await writeFile(join(packageRoot, scriptName ?? ''), '')
    await writeFile(join(packageRoot, 'package.json'), JSON.stringify({ version: '9.9.9' }))

    // 不给任何 resourceRoots、也不往登记表里登记：宿主把安装根登记在自己的表里时本包看不到，
    // 共享资源根属于平台约定，必须由本包自己算出来。
    const resolved = createComputerHelperLocator().resolve()
    expect(resolved?.packageRoot).toBe(packageRoot)
    expect(resolved?.pythonCommand).toBe(venvPython)
    expect(resolved?.version).toBe('9.9.9')
  })
})

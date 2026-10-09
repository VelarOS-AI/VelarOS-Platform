import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

import { afterEach, describe, expect, test } from 'bun:test'

import type { ComputerResourcePort } from '../../index'
import { createComputerHelperLocator } from '../../index'

const HelperScriptNames: Partial<Record<NodeJS.Platform, string>> = {
  darwin: 'mac_helper.py',
  linux: 'linux_helper.py',
  win32: 'win_helper.py',
}

const scriptName = HelperScriptNames[process.platform]
const supportedTest = scriptName ? test : test.skip

let createdRoot: Nullable<string> = null

afterEach(async () => {
  if (createdRoot) {
    await rm(createdRoot, { recursive: true, force: true })
    createdRoot = null
  }
})

/** 在一个临时根里摆出一份「已安装」的平台包：helper 脚本 + 自带 venv + package.json。 */
async function installFakePackage(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'velaros-computer-resources-'))
  createdRoot = root
  const packageRoot = join(root, 'computer-use', `computeruse-${process.platform}-${process.arch}`)
  const venvDirectory = process.platform === 'win32' ? 'Scripts' : 'bin'
  const venvPython = join(
    packageRoot,
    'venv',
    venvDirectory,
    process.platform === 'win32' ? 'python.exe' : 'python'
  )
  await mkdir(join(packageRoot, 'venv', venvDirectory), { recursive: true })
  await writeFile(venvPython, '')
  await writeFile(join(packageRoot, scriptName ?? ''), '')
  await writeFile(join(packageRoot, 'package.json'), JSON.stringify({ version: '9.9.9' }))
  return root
}

describe('helper 定位器的资源来源', () => {
  supportedTest('优先使用应用自带的可迁移 Python', async () => {
    const root = await installFakePackage()
    const packageRoot = join(
      root,
      'computer-use',
      `computeruse-${process.platform}-${process.arch}`
    )
    const python =
      process.platform === 'win32'
        ? join(packageRoot, 'python', 'python.exe')
        : join(packageRoot, 'python', 'bin', 'python3')
    await mkdir(dirname(python), { recursive: true })
    await writeFile(python, '')
    const locator = createComputerHelperLocator({ resourceRoots: [root] })
    expect(locator.resolve()?.pythonCommand).toBe(python)
  })

  supportedTest('按宿主注入的安装根找到平台包', async () => {
    const root = await installFakePackage()
    const resources: ComputerResourcePort = {
      extraResourceRoots: () => [root],
      isDisabled: () => false,
    }

    const locator = createComputerHelperLocator({ resourceRoots: [root], resources })

    expect(locator.resolve()?.version).toBe('9.9.9')
    expect(locator.resolveIgnoringDisabled()?.bundledVenv).toBe(true)
  })

  supportedTest('用户停用时 resolve 返回 null，但「装了没有」仍答得出来', async () => {
    const root = await installFakePackage()
    const disabled: string[] = []
    const resources: ComputerResourcePort = {
      extraResourceRoots: () => [root],
      isDisabled: (id) => {
        disabled.push(id)
        return true
      },
    }

    const locator = createComputerHelperLocator({ resourceRoots: [root], resources })

    expect(locator.resolve()).toBeNull()
    expect(disabled).toEqual(['computeruse'])
    expect(locator.resolveIgnoringDisabled()?.packageRoot).toContain('computeruse-')
  })

  test('不给资源来源时不认为被停用，也不额外加根', () => {
    const locator = createComputerHelperLocator({ resourceRoots: [] })

    expect(locator.resolve()).toBeNull()
    expect(locator.bundledSourceRoot()).toContain('runtime')
  })
})

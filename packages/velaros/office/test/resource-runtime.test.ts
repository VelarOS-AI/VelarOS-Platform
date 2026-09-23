import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, test } from 'bun:test'

import type { OfficeResourcePort } from '../index'
import { createMarkItDownLocator } from '../index'

let createdRoot: Nullable<string> = null

afterEach(async () => {
  if (createdRoot) {
    await rm(createdRoot, { recursive: true, force: true })
    createdRoot = null
  }
})

/** 造一份「已安装」的 MarkItDown 资源包，返回它所在的资源根。 */
async function installFakeMarkItDown(): Promise<string> {
  const resourceRoot = await mkdtemp(join(tmpdir(), 'velaros-office-resource-port-'))
  createdRoot = resourceRoot
  const packageRoot = join(
    resourceRoot,
    'markitdown',
    `markitdown-${process.platform}-${process.arch}`
  )
  await mkdir(join(packageRoot, 'bin'), { recursive: true })
  await writeFile(join(packageRoot, 'package.json'), JSON.stringify({ version: '1.2.3' }), 'utf8')
  for (const name of ['markitdown', 'markitdown.cmd', 'markitdown.exe']) {
    const binary = join(packageRoot, 'bin', name)
    await writeFile(binary, '#!/bin/sh\n', 'utf8')
    await chmod(binary, 0o755)
  }
  return resourceRoot
}

describe('MarkItDown 定位器的注入面', () => {
  test('宿主给的额外资源根会被搜到，停用开关只挡 resolve', async () => {
    const resourceRoot = await installFakeMarkItDown()
    let disabled = false
    const resources: OfficeResourcePort = {
      extraResourceRoots: () => [resourceRoot],
      isDisabled: (id) => id === 'markitdown' && disabled,
    }
    const locator = createMarkItDownLocator({ resources })

    expect(locator.resolve()?.version).toBe('1.2.3')

    disabled = true
    // 用户在设置里停用后 resolve 返回 null，但「物理上装没装」仍然如实回答。
    expect(locator.resolve()).toBeNull()
    expect(locator.resolveIgnoringDisabled()?.packageRoot).toContain(resourceRoot)
  })

  test('没有资源端口时不看停用开关，只按显式资源根找', async () => {
    const resourceRoot = await installFakeMarkItDown()

    expect(createMarkItDownLocator({ resourceRoots: [resourceRoot] }).resolve()).not.toBeNull()
    expect(
      createMarkItDownLocator({ resourceRoots: [join(resourceRoot, 'nowhere')] }).resolve()
    ).toBeNull()
  })
})

import { existsSync } from 'node:fs'
import { join } from 'node:path'

import { describe, expect, test } from 'bun:test'

import {
  ComputerHelperErrorCodes,
  ComputerResourceLayout,
} from '../../src/exports/contracts'
import {
  ComputerSidecarManager,
  createComputerHelperLocator,
  resolveBundledComputerRuntimeSourceRoot,
} from '../../src/exports/runtime'
import { decodeComputerResponse } from '../../src/exports/runtime'

const HelperScriptNames: Partial<Record<NodeJS.Platform, string>> = {
  darwin: 'mac_helper.py',
  linux: 'linux_helper.py',
  win32: 'win_helper.py',
}

describe('桌面控制的失败面', () => {
  test('helper 没装时的可用性结果是中文，且原因是 helper-missing', async () => {
    const manager = new ComputerSidecarManager({ resolveHelper: () => null })

    try {
      const availability = await manager.ensureAvailable()

      expect(availability).toMatchObject({ available: false, reason: 'helper-missing' })
      expect(availability.detail).toContain('桌面控制')
    } finally {
      manager.dispose()
    }
  })

  test('释放之后的调用报中文，错误码不变', async () => {
    const manager = new ComputerSidecarManager({ resolveHelper: () => null })
    manager.dispose()

    await expect(manager.screenSize()).rejects.toMatchObject({
      code: 'COMPUTER_SIDECAR_DISPOSED',
    })
    await expect(manager.screenSize()).rejects.toThrow('桌面控制 sidecar 已释放')
  })

  test('协议坏帧的报错是中文，错误码是协议码', () => {
    expect(() => decodeComputerResponse('')).toThrow('空行')
    expect(() => decodeComputerResponse('{')).toThrow('不是合法 JSON')
    expect(() => decodeComputerResponse('{"id":1}')).toThrow('缺少布尔字段 ok')
    expect(() => decodeComputerResponse('{"id":1}')).toThrow(
      expect.objectContaining({ code: 'COMPUTER_PROTOCOL_INVALID' }),
    )
  })

  test('helper 的英文错误按码翻成中文，码本身原样带在上下文里', () => {
    // 这一帧是 helper 真实会回的形状：码是约定，message 是英文原文。
    const response = decodeComputerResponse(
      JSON.stringify({
        id: 1,
        ok: false,
        error: {
          code: ComputerHelperErrorCodes.snapshotStale,
          message: 'The screenshot is unknown or expired; take a new computer:screenshot',
        },
      }),
    )

    expect(response.ok).toBe(false)
    if (response.ok) return
    expect(response.error.code).toBe(ComputerHelperErrorCodes.snapshotStale)
  })

  test('随包 helper 资产目录真的存在，并且装着本平台的脚本', () => {
    const root = resolveBundledComputerRuntimeSourceRoot()

    expect(root.endsWith(ComputerResourceLayout.bundledRuntimeDirectory)).toBe(true)
    expect(existsSync(join(root, 'mac_helper.py'))).toBe(true)
    expect(existsSync(join(root, HelperScriptNames[process.platform] ?? 'mac_helper.py'))).toBe(true)
    expect(createComputerHelperLocator().bundledSourceRoot()).toBe(root)
  })
})

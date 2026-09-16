import { spawn } from 'node:child_process'

import { describe, expect, test } from 'bun:test'

import type { ComputerHelperLaunchSpec, ComputerSidecarProcess } from '../../src/index'
import { createComputerRuntime } from '../../src/index'

/** 假 helper 用 `sh` 扮演：EPIPE、半行崩溃、卡在启动这三种故障都要真管道才复现得出来。 */
const posixTest = process.platform === 'win32' ? test.skip : test

const HelperSpec: ComputerHelperLaunchSpec = {
  pythonCommand: 'sh',
  helperScript: '/fake/helper.py',
  runtimeDir: '/fake',
  packageRoot: '/fake',
  version: 'test',
  bundledVenv: true,
}

const Handshake = String.raw`printf '{"id":0,"ok":true,"result":{"ready":true}}\n'`

function shellSpawner(script: () => string): () => ComputerSidecarProcess {
  return () =>
    spawn('sh', ['-c', script()], {
      stdio: ['pipe', 'pipe', 'pipe'],
    }) as unknown as ComputerSidecarProcess
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

describe('computer sidecar 韧性', () => {
  posixTest('helper 关掉 stdin 后写请求不会变成宿主的未捕获异常', async () => {
    const uncaught: unknown[] = []
    const onUncaught = (error: unknown) => {
      uncaught.push(error)
    }
    process.on('uncaughtException', onUncaught)
    const manager = createComputerRuntime({
      resolveHelper: () => HelperSpec,
      // 握手后关掉自己的输入仍存活：写请求触发的 EPIPE 只经 stdin 的 'error' 事件到达。
      spawnProcess: shellSpawner(() => `${Handshake}; exec 0<&-; sleep 5`),
      requestTimeoutMs: 1_000,
      startupTimeoutMs: 3_000,
    })

    try {
      // 先让 sidecar 完成握手；这一次请求本身就会拉起它。
      await expect(manager.screenSize()).rejects.toBeDefined()
      await delay(100)
      // 一次够大的写入才会真的撞上已经关掉的管道。
      await expect(manager.typeText('x'.repeat(200_000))).rejects.toBeDefined()
      // 管道错误是异步事件，留一个窗口让它到达；到达时若无人接管就会进 uncaughtException。
      await delay(300)
      expect(uncaught).toEqual([])
    } finally {
      manager.dispose()
      process.off('uncaughtException', onUncaught)
    }
  })

  posixTest('helper 死在半行 JSON 上之后，下一次请求仍能完成握手', async () => {
    let launches = 0
    const manager = createComputerRuntime({
      resolveHelper: () => HelperSpec,
      spawnProcess: shellSpawner(() => {
        launches += 1
        return launches === 1
          ? String.raw`printf '{"id":0,"ok":true,"result":{}}\n{"id":1,"ok":tr'; exit 3`
          : `${Handshake}; while read line; do printf '{"id":2,"ok":true,"result":{"width":1}}\n'; done`
      }),
      requestTimeoutMs: 2_000,
      startupTimeoutMs: 3_000,
    })

    try {
      await expect(manager.screenSize()).rejects.toBeDefined()
      // 残片若留在行缓冲里，会粘在第二个 helper 的握手行前面，整行被当坏帧丢掉 → 永远挂起。
      expect(await manager.screenSize()).toMatchObject({ width: 1 })
      expect(launches).toBe(2)
    } finally {
      manager.dispose()
    }
  })

  posixTest('helper 不打握手时按 startupTimeoutMs 失败，请求不会永远挂起', async () => {
    const manager = createComputerRuntime({
      resolveHelper: () => HelperSpec,
      spawnProcess: shellSpawner(() => 'sleep 5'),
      requestTimeoutMs: 5_000,
      startupTimeoutMs: 300,
    })

    try {
      await expect(manager.screenSize()).rejects.toMatchObject({
        code: 'COMPUTER_SIDECAR_STARTUP_TIMEOUT',
      })
      const availability = await manager.ensureAvailable()
      expect(availability.available).toBe(false)
    } finally {
      manager.dispose()
    }
  })
})

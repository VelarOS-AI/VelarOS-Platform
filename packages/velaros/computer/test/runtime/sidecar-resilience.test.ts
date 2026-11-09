import { spawn } from 'node:child_process'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { describe, expect, test } from 'bun:test'

import type { ComputerHelperLaunchSpec, ComputerSidecarProcess } from '../../index'
import { createComputerRuntime } from '../../index'
import { spawnComputerHelperProcess } from '../../utils/process'

/** POSIX 断管用 sh，恢复时序用跨平台 Node；故障均经真实子进程管道触发。 */
const posixTest = process.platform === 'win32' ? test.skip : test

const HelperSpec: ComputerHelperLaunchSpec = {
  pythonCommand: 'sh',
  helperScript: '/fake/helper.py',
  runtimeDir: '/fake',
  packageRoot: '/fake',
  version: 'test',
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
  test('默认启动器在 stdout 和 stderr 排空之后才通知进程退出', async () => {
    const root = await mkdtemp(join(tmpdir(), 'computer-close-'))
    const helper = join(root, 'helper.cjs')
    let child: ComputerSidecarProcess | undefined
    try {
      await writeFile(
        helper,
        'process.stdout.write("x".repeat(262144)); process.stderr.write("诊断😀".repeat(65536));'
      )
      child = spawnComputerHelperProcess({
        ...HelperSpec,
        pythonCommand: process.execPath,
        helperScript: helper,
        runtimeDir: root,
      })
      let stdoutBytes = 0
      let stderrBytes = 0
      child.stdout.on('data', (chunk) => {
        stdoutBytes += Buffer.byteLength(chunk)
      })
      child.stderr.on('data', (chunk) => {
        stderrBytes += Buffer.byteLength(chunk)
      })
      await new Promise<void>((resolve, reject) => {
        child!.on('error', reject)
        child!.on('exit', (code) => {
          try {
            expect(code).toBe(0)
            expect(stdoutBytes).toBe(262144)
            expect(stderrBytes).toBe(Buffer.byteLength('诊断😀') * 65536)
            resolve()
          } catch (error) {
            reject(error)
          }
        })
      })
    } finally {
      child?.kill()
      await rm(root, { recursive: true, force: true })
    }
  })

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

  for (const receivedRequest of [false, true]) {
    test(`helper 在${receivedRequest ? '收到请求后' : '握手前'}死在半行 JSON 后仍能重启`, async () => {
      let launches = 0
      const manager = createComputerRuntime({
        resolveHelper: () => HelperSpec,
        spawnProcess: () => {
          launches += 1
          const script =
            launches === 1
              ? receivedRequest
                ? String.raw`process.stdout.write('{"id":0,"ok":true,"result":{"ready":true}}\n'); process.stdin.once('data', () => process.stdout.write('{"id":1,"ok":tr', () => process.exit(3)));`
                : String.raw`process.stdout.write('{"id":0,"ok":tr', () => process.exit(3));`
              : String.raw`const {createInterface} = require('node:readline'); process.stdout.write('{"id":0,"ok":true,"result":{"ready":true}}\n'); createInterface({input:process.stdin}).on('line', line => { const {id} = JSON.parse(line); process.stdout.write(JSON.stringify({id,ok:true,result:{width:1,requestId:id}})+'\n'); });`
          const child = spawn('node', ['-e', script], { stdio: ['pipe', 'pipe', 'pipe'] })
          return child as unknown as ComputerSidecarProcess
        },
        requestTimeoutMs: 2_000,
        startupTimeoutMs: 3_000,
      })

      try {
        await expect(manager.screenSize()).rejects.toMatchObject({
          code: 'COMPUTER_SIDECAR_EXITED',
          context: { exitCode: 3 },
        })
        // 残片若留在行缓冲里，会粘在第二个 helper 的握手行前面，整行被当坏帧丢掉 → 永远挂起。
        expect(await manager.screenSize()).toMatchObject({
          width: 1,
          requestId: receivedRequest ? 2 : 1,
        })
        expect(launches).toBe(2)
      } finally {
        manager.dispose()
      }
    })
  }

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

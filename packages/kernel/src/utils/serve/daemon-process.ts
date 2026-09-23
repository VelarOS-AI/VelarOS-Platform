import type { ChildProcess } from 'node:child_process'
import { type FileHandle, open, readFile, rename, stat, unlink, writeFile } from 'node:fs/promises'

import { isFunction, isNotNull, isNotUndefined, isNull, isObject, Log } from '@velaros-ai/core'
import { TimerScope } from '@velaros-ai/core/utils/TimerScope'

import { KernelClientErrorCodes } from '../../contract/constants'
import type { KernelDaemonEndpointDescriptor } from '../../types/kernel.js'
import { KernelClientError } from '../errors'
import { ignoreMissing, isNodeError } from '../fs'
import { KernelTuning } from '../tuning'

const log = Log.tag('KernelDaemonProcess')

/**
 * 运行目录必须归自己所有、且只有自己能进。
 *
 * 缺省落点在共享的 `<tmpdir>/velaros-kernel-<uid>`：另一个用户预先建好这个目录，就能替换
 * descriptor 把客户端引到自己的 socket，客户端会把认证令牌发过去。`mkdir` 的 `mode` 只在
 * **新建**时生效，目录已存在时既不改权限也不核属主——这里补上这道闸。
 *
 * Windows 没有 POSIX 属主与模式位（`process.getuid` 不存在），跳过。
 */
export async function assertKernelRuntimeDirectoryIsPrivate(directory: string): Promise<void> {
  if (!isFunction(process.getuid)) return
  const stats = await stat(directory)
  const uid = process.getuid()
  if (stats.uid !== uid) {
    throw new KernelClientError({
      code: KernelClientErrorCodes.daemonLockFailed,
      message: `Kernel 运行目录 ${directory} 属于 uid ${stats.uid}，不是当前用户（uid ${uid}），拒绝使用`,
    })
  }
  // 权限位低六位是「组」与「其他人」的读写执行；只要有一位是 1，同机别的用户就进得来。
  const groupAndOtherBits = stats.mode & 0o077
  if (groupAndOtherBits !== 0) {
    throw new KernelClientError({
      code: KernelClientErrorCodes.daemonLockFailed,
      message: `Kernel 运行目录 ${directory} 的权限是 ${(stats.mode & 0o777).toString(8)}，对同机其他用户开放，拒绝使用（应为 700）`,
    })
  }
}

/** descriptor 或锁文件里记的进程还活着吗；EPERM 表示进程在、但属于别人（共享守护进程的常态），照样算活着。 */
export function isKernelDaemonProcessAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return isNodeError(error, 'EPERM')
  }
}

/** 读锁文件里记的属主 pid；读不出来（文件刚建还没写、内容坏了）就回 undefined，不抛。 */
export async function readKernelDaemonLockOwnerPid(path: string): Promise<number | undefined> {
  try {
    const input = JSON.parse(await readFile(path, 'utf8')) as unknown
    if (!isObject(input) || isNull(input)) return undefined
    const pid = Reflect.get(input, 'pid')
    return Number.isInteger(pid) && (pid as number) > 0 ? (pid as number) : undefined
  } catch (error) {
    log.debug('Kernel 守护进程锁读不出属主', { error, path })
    return undefined
  }
}

/** 按可调参数里的次数与间隔重读属主 pid：对方可能刚 `open` 还没写完 pid，别把成型中的锁当死锁。 */
export async function readKernelDaemonLockOwnerPidWithRetry(
  path: string
): Promise<number | undefined> {
  for (let attempt = 0; attempt <= KernelTuning.lockOwnerReadRetries; attempt += 1) {
    const pid = await readKernelDaemonLockOwnerPid(path)
    if (isNotUndefined(pid)) return pid
    if (attempt < KernelTuning.lockOwnerReadRetries) {
      await TimerScope.sleep(KernelTuning.lockOwnerReadRetryMs, {
        label: 'KernelDaemon.lockOwnerRead',
      })
    }
  }
  return undefined
}

/**
 * 抢本机单实例锁；抢不到时按「已经有一个守护进程在跑」抛带码的错误。
 *
 * 属主已经死了就删掉陈旧锁再抢一次；读不出属主则一律按被占用处理，宁可不起也不并存两个。
 */
export async function acquireKernelDaemonLock(
  lockPath: string,
  instanceId: string
): Promise<FileHandle> {
  // 最多两轮：第一轮抢，属主死了删锁，第二轮再抢；再抢不到就是真有人在跑。
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const handle = await open(lockPath, 'wx', 0o600)
      await handle.writeFile(JSON.stringify({ instanceId, pid: process.pid }), 'utf8')
      return handle
    } catch (error) {
      if (!isNodeError(error, 'EEXIST')) throw error
      const ownerPid = await readKernelDaemonLockOwnerPidWithRetry(lockPath)
      if (isNotUndefined(ownerPid)) {
        if (isKernelDaemonProcessAlive(ownerPid)) {
          throw new KernelClientError({
            code: KernelClientErrorCodes.daemonAlreadyRunning,
            message: '本机端点已经被另一个 Kernel 守护进程占用',
          })
        }
        await unlink(lockPath).catch(ignoreMissing)
        continue
      }
      throw new KernelClientError({
        code: KernelClientErrorCodes.daemonLockFailed,
        message: `Kernel 守护进程锁存在但读不出属主，按被占用处理；若确认没有 Kernel 在跑，删掉 ${lockPath} 后重试`,
      })
    }
  }
  throw new KernelClientError({
    code: KernelClientErrorCodes.daemonLockFailed,
    message: 'Kernel 守护进程锁获取失败',
  })
}

/** 把端点 descriptor 写成只有属主可读的文件；先写同目录临时文件再改名，读的人永远看不到半份。 */
export async function writeKernelDaemonDescriptor(
  path: string,
  descriptor: KernelDaemonEndpointDescriptor
): Promise<void> {
  const temporaryPath = `${path}.${descriptor.instanceId}.tmp`
  await writeFile(temporaryPath, `${JSON.stringify(descriptor)}\n`, {
    encoding: 'utf8',
    mode: 0o600,
  })
  await rename(temporaryPath, path)
}

/** 子进程已经退了吗（退出码或终止信号任一有值就算退了）。 */
export function hasChildProcessExited(child: ChildProcess): boolean {
  return isNotNull(child.exitCode) || isNotNull(child.signalCode)
}

/**
 * 这个错误是不是「守护进程没在跑」。
 *
 * 崩溃后残留的 descriptor 指着一个没人听的端点：连接会以 `TRANSPORT_CONNECT_FAILED` 失败，
 * 而不是 `DAEMON_NOT_RUNNING`。只吞后者的话，启动器会被一份陈旧文件卡死、一次都不 spawn。
 */
export function meansKernelDaemonIsNotRunning(error: unknown): boolean {
  if (!(error instanceof KernelClientError)) return false
  return (
    error.code === KernelClientErrorCodes.daemonNotRunning ||
    error.code === KernelClientErrorCodes.daemonDescriptorInvalid ||
    error.code === KernelClientErrorCodes.transportConnectFailed ||
    error.code === KernelClientErrorCodes.transportDisconnected
  )
}

/** 在常见的终止信号上挂停机动作，停成了退 0、停砸了退 1；返回一个摘掉这些监听器的函数。 */
export function installKernelShutdownSignalHandlers(stop: () => Promise<void>): () => void {
  let stopping = false
  const onSignal = (): void => {
    if (stopping) return
    stopping = true
    void stop().then(
      () => process.exit(0),
      () => process.exit(1)
    )
  }
  const signals: readonly NodeJS.Signals[] = ['SIGINT', 'SIGTERM', 'SIGHUP']
  for (const signal of signals) process.on(signal, onSignal)
  return () => {
    for (const signal of signals) process.off(signal, onSignal)
  }
}

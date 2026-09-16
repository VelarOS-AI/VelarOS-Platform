import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { isBlank, isFunction, isNotUndefined, isNull, isObject, isString } from '@velaros-ai/core';

import { KernelClientErrorCodes } from '../../contract/constants'
import type { KernelDaemonEndpointDescriptor, KernelDaemonPaths, KernelRpcEndpoint } from '../../types/kernel.js'
import { KernelClientError } from '../errors'

/** Kernel 运行目录：优先用登记过的环境变量，否则按当前用户在临时目录下开一个私有目录。 */
export function defaultKernelRuntimeDirectory(): string {
  const configured = process.env.VELAROS_KERNEL_RUNTIME_DIR
  if (isNotUndefined(configured) && !isBlank(configured.trim())) return configured
  const userIdentity = isFunction(process.getuid)
    ? String(process.getuid())
    : process.env.USERNAME ?? 'user'
  return join(tmpdir(), `velaros-kernel-${userIdentity}`)
}

/** 按运行目录折出守护进程的三条路径：端点 descriptor、单实例锁、unix socket。 */
export function createDefaultKernelDaemonPaths(
  name = 'velaros-kernel',
  runtimeDirectory = defaultKernelRuntimeDirectory(),
): KernelDaemonPaths {
  const safeName = name.replaceAll(/[^a-zA-Z0-9._-]/g, '-')
  return {
    descriptorPath: join(runtimeDirectory, `${safeName}.endpoint.json`),
    lockPath: join(runtimeDirectory, `${safeName}.lock`),
    socketPath: join(runtimeDirectory, `${safeName}.sock`),
  }
}

/** 校验并解析端点 descriptor；任何一个字段不合格都抛 `DAEMON_DESCRIPTOR_INVALID`。 */
export function parseKernelDaemonDescriptor(
  input: unknown,
): KernelDaemonEndpointDescriptor {
  if (!isObject(input) && !isNull(input) || isNull(input)) {
    throw invalidDescriptor()
  }
  const instanceId = Reflect.get(input, 'instanceId')
  const authToken = Reflect.get(input, 'authToken')
  const protocolVersion = Reflect.get(input, 'protocolVersion')
  const kernelVersion = Reflect.get(input, 'kernelVersion')
  const pid = Reflect.get(input, 'pid')
  const startedAt = Reflect.get(input, 'startedAt')
  const endpoint = parseEndpoint(Reflect.get(input, 'endpoint'))
  if (
    !isString(instanceId)
    || instanceId.length === 0
    || !isString(authToken)
    || authToken.length < 32
    || !Number.isInteger(protocolVersion)
    || !isString(kernelVersion)
    || kernelVersion.length === 0
    || !Number.isInteger(pid)
    || !Number.isInteger(startedAt)
  ) {
    throw invalidDescriptor()
  }
  return {
    authToken,
    instanceId,
    protocolVersion: protocolVersion as number,
    kernelVersion,
    pid: pid as number,
    startedAt: startedAt as number,
    endpoint,
  }
}

/** 解析 descriptor 里的端点：unix 要有路径，tcp 只认回环地址加正整数端口。 */
function parseEndpoint(input: unknown): KernelRpcEndpoint {
  if (!isObject(input) && !isNull(input) || isNull(input)) throw invalidDescriptor()
  const kind = Reflect.get(input, 'kind')
  if (kind === 'unix') {
    const path = Reflect.get(input, 'path')
    if (!isString(path) || path.length === 0) throw invalidDescriptor()
    return { kind, path }
  }
  if (kind === 'tcp') {
    const host = Reflect.get(input, 'host')
    const port = Reflect.get(input, 'port')
    if (
      host !== '127.0.0.1'
      || !Number.isInteger(port)
      || (port as number) <= 0
    ) {
      throw invalidDescriptor()
    }
    return { kind, host, port: port as number }
  }
  throw invalidDescriptor()
}

/** 折一个「descriptor 不合法」的带码错误，上面几处校验共用它。 */
function invalidDescriptor(): KernelClientError {
  return new KernelClientError({
    code: KernelClientErrorCodes.daemonDescriptorInvalid,
    message: 'Kernel 守护进程的端点 descriptor 不合法',
  })
}

import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { isBlank, isFunction, isNotUndefined, isNull, isObject, isString } from '@velaros-ai/core';

import { KernelClientError } from '../errors'

import type { KernelRpcEndpoint } from './endpoint'

/** Filesystem locations of the single-instance local Kernel daemon. */
export interface KernelDaemonPaths {
  readonly descriptorPath: string
  readonly lockPath: string
  readonly socketPath: string
}

/**
 * Endpoint descriptor published by a running Kernel daemon.
 *
 * The daemon writes it; clients read it. Both sides share this one definition
 * so the on-disk contract cannot drift between server and client.
 */
export interface KernelDaemonEndpointDescriptor {
  readonly authToken: string
  readonly instanceId: string
  readonly protocolVersion: number
  readonly kernelVersion: string
  readonly pid: number
  readonly startedAt: number
  readonly endpoint: KernelRpcEndpoint
}

export function defaultKernelRuntimeDirectory(): string {
  const configured = process.env.VELAROS_KERNEL_RUNTIME_DIR
  if (isNotUndefined(configured) && !isBlank(configured.trim())) return configured
  const userIdentity = isFunction(process.getuid)
    ? String(process.getuid())
    : process.env.USERNAME ?? 'user'
  return join(tmpdir(), `velaros-kernel-${userIdentity}`)
}

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

function invalidDescriptor(): KernelClientError {
  return new KernelClientError(
    'DAEMON_DESCRIPTOR_INVALID',
    'Kernel daemon endpoint descriptor is invalid',
  )
}

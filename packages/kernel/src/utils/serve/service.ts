import { isEmpty, isNull, isObject, isString, toNullable, toOptional } from '@velaros-ai/core'

import type {
  KernelModuleSnapshot,
  KernelServiceModuleHealth,
  ScopeRef,
} from '../../types/kernel.js'
import type {
  CapabilityCallFailure,
  CapabilityCallRequest,
  CapabilitySessionOpenFailure,
  KernelModuleDescriptor,
  ScopeRef as KernelWireScopeRef,
} from '../../types/wire.js'
import { KernelProtocolVersion } from '../wire/version'

/** 目录修订号：同一个模块换了版本或换了代，这个串就变，客户端据此判断手上的描述过没过期。 */
export function toModuleCatalogRevision(snapshot: KernelModuleSnapshot): string {
  const { id, version } = snapshot.manifest
  return `${id}@${version}#${snapshot.generation}`
}

/** 把宿主里的模块快照投影成 wire 上的模块描述（握手与目录都用它）。 */
export function toKernelModuleDescriptor(snapshot: KernelModuleSnapshot): KernelModuleDescriptor {
  const { manifest } = snapshot
  return {
    id: manifest.id,
    version: manifest.version,
    apiVersion: manifest.apiVersion,
    provides: manifest.provides.map(({ id, version }) => ({ id, version })),
    requires: manifest.requires.map(({ id, versionRange }) => ({
      id,
      versionRange: toNullable(versionRange),
    })),
    optionalRequires: manifest.optionalRequires.map(({ id, versionRange }) => ({
      id,
      versionRange: toNullable(versionRange),
    })),
    permissions: [...manifest.permissions],
    isolation: manifest.isolation,
    catalogRevision: toModuleCatalogRevision(snapshot),
  }
}

/** 折一个能力调用的失败信封：码与说明原样带回调用方，`retryable` 说明值不值得再试一次。 */
export function capabilityCallFailure(
  callId: string,
  code: string,
  message: string,
  retryable = false,
  details: Nullable<Readonly<Record<string, unknown>>> = null
): CapabilityCallFailure {
  return {
    protocolVersion: KernelProtocolVersion,
    callId,
    status: 'error',
    error: {
      code,
      message,
      retryable,
      details,
    },
  }
}

/** 折一个「打开能力会话」的失败信封。 */
export function capabilitySessionOpenFailure(
  code: string,
  message: string,
  retryable = false
): CapabilitySessionOpenFailure {
  return {
    protocolVersion: KernelProtocolVersion,
    status: 'error',
    error: {
      code,
      message,
      retryable,
      details: null,
    },
  }
}

/** 把模块快照投影成健康报告里的一行。 */
export function toKernelServiceModuleHealth(
  snapshot: KernelModuleSnapshot
): KernelServiceModuleHealth {
  return {
    id: snapshot.manifest.id,
    version: snapshot.manifest.version,
    generation: snapshot.generation,
    status: snapshot.status,
    health: snapshot.health,
    error: snapshot.error,
  }
}

/** 把 wire 上的作用域（缺省是 `null`）转成 SDK 侧的作用域（缺省是 `undefined`）。 */
export function toKernelCapabilityScope(
  scope: CapabilityCallRequest['scope']
): ScopeRef | undefined {
  if (isNull(scope)) return undefined
  return {
    id: scope.id,
    ownerModuleId: scope.ownerModuleId,
    kind: toOptional(scope.kind),
  }
}

/**
 * 从一份还没校验过的请求里尽力读出 callId。
 *
 * 请求本身不合协议时也要回一个能对上号的失败帧；读不出来就用 `invalid-call` 占位。
 */
export function readCapabilityCallId(input: unknown): string {
  if (!isObject(input) || isNull(input)) return 'invalid-call'
  const callId = Reflect.get(input, 'callId')
  return isString(callId) && !isEmpty(callId) ? callId : 'invalid-call'
}

/** 会话绑下的操作集合覆不覆盖这次调用的操作；`null` 表示全部操作都在里面。 */
export function capabilityOperationsCover(
  granted: Nullable<ReadonlySet<string>>,
  operation: string
): boolean {
  if (isNull(granted)) return true
  return granted.has(operation)
}

/** 会话绑下的作用域覆不覆盖这次调用的作用域；绑的是 `null` 表示不限，请求是 `null` 则不给过。 */
export function capabilityScopesCover(
  granted: Nullable<KernelWireScopeRef>,
  requested: Nullable<KernelWireScopeRef>
): boolean {
  if (isNull(granted)) return true
  if (isNull(requested)) return false
  return (
    granted.id === requested.id &&
    granted.ownerModuleId === requested.ownerModuleId &&
    granted.kind === requested.kind
  )
}

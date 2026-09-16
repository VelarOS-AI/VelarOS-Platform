// 域：Agent 工具契约的结果信封与租约拒绝响应的构造口。schema 在 ./lease，这里只负责按 schema 拼出对象。
import { isEmpty, isPlainObject } from '@velaros-ai/core'

import type { LeaseDenialReason, LeaseDeniedResponse, ToolCatalogEntry, VelarToolCallEnvelope, VelarToolResultEnvelope } from '../../types/agent.js'
import type { ToolCatalogSnapshot } from '../../types/tools.js'
import type { ToolResult } from '../../types/tools.js'
import { readToolSchemaDiscoveryNames } from '../toolkit/discovery'

import { AgentProtocolVersion } from './version'

/**
 * 结果信封里与调用信封对称的那几个字段：协议版本、契约号、目录修订号、调用号与工具名。
 * 每个结果都从它起头，保证请求与回执能一一对上，`status` / `output` / `error` 由各自的构造口补齐。
 */
export function buildToolContractBaseEnvelope(
  envelope: VelarToolCallEnvelope,
  catalogRevision: string,
): Pick<
  VelarToolResultEnvelope,
  'protocolVersion' | 'contractId' | 'catalogRevision' | 'toolCallId' | 'toolName'
> {
  return {
    protocolVersion: AgentProtocolVersion,
    contractId: envelope.contractId,
    catalogRevision,
    toolCallId: envelope.toolCallId,
    toolName: envelope.toolName,
  }
}

/** 成功回执：`output` 原样放进信封，不做序列化也不裁剪，交给对端自己解释。 */
export function buildToolContractSuccessEnvelope(
  envelope: VelarToolCallEnvelope,
  catalogRevision: string,
  output: unknown,
): VelarToolResultEnvelope {
  return { ...buildToolContractBaseEnvelope(envelope, catalogRevision), status: 'success', output }
}

/** 出错回执：`error` 是给对端读的一句失败说明，没有 output。用于参数校验一类的执行前失败。 */
export function buildToolContractErrorEnvelope(
  envelope: VelarToolCallEnvelope,
  catalogRevision: string,
  error: string,
): VelarToolResultEnvelope {
  return { ...buildToolContractBaseEnvelope(envelope, catalogRevision), status: 'error', error }
}

/**
 * 把一次真实执行的结果折成回执：没有 error 就是 success；有 error 时再看结果体是不是 `tool_denied`，
 * 是就报 `denied`（权限层拒绝），否则报 `error`（执行层失败）。两种情况都把模型面结果一起带回去。
 */
export function buildToolContractResultEnvelope(
  envelope: VelarToolCallEnvelope,
  catalogRevision: string,
  result: ToolResult,
): VelarToolResultEnvelope {
  const base = buildToolContractBaseEnvelope(envelope, catalogRevision)
  if (result.error) return {
      ...base,
      status: isPlainObject(result.result) && result.result.error === 'tool_denied' ? 'denied' : 'error',
      error: result.error,
      output: result.modelResult ?? result.result,
    }
  return { ...base, status: 'success', output: result.modelResult ?? result.result }
}

/** 目录自恢复工具的答复体：当前可见工具全表加上它的修订号，对端拿去替换本地缓存的目录。 */
export function buildToolCatalogSnapshot(
  tools: ToolCatalogEntry[],
  catalogRevision: string,
): ToolCatalogSnapshot {
  return { protocolVersion: AgentProtocolVersion, catalogRevision, tools }
}

/**
 * schema 自恢复工具的答复：按信封里给的工具名逐个在当前目录里找，找到的进 `tools`、没找到的进 `missing`，
 * 让对端一次就知道哪些名字已经不在目录里了。一个名字都没给是调用方用错了协议，回一条 error 回执。
 */
export function buildToolSchemaDiscoveryEnvelope(
  envelope: VelarToolCallEnvelope,
  tools: ToolCatalogEntry[],
  catalogRevision: string,
): VelarToolResultEnvelope {
  const names = readToolSchemaDiscoveryNames(envelope.input)
  if (isEmpty(names)) return buildToolContractErrorEnvelope(
      envelope,
      catalogRevision,
      'names 必须包含 1 到 12 个工具名。',
    )
  const byName = new Map(tools.map((tool) => [tool.name, tool]))
  return buildToolContractSuccessEnvelope(envelope, catalogRevision, {
    catalogRevision,
    tools: names.flatMap((name) => {
      const descriptor = byName.get(name)
      return descriptor ? [descriptor] : []
    }),
    missing: names.filter((name) => !byName.has(name)),
  })
}

/**
 * 执行前的租约层拒绝：和结果信封的 `status: 'denied'`（权限拒绝）是两码事，这条是「你的目录过期了 / 这个工具不在你的范围里」。
 * 一定带上 `latestCatalogRevision`，对端据此续租重取目录，而不是把这次调用当成故障。
 */
export function buildLeaseDeniedResponse(
  reason: LeaseDenialReason,
  contractId: string,
  latestCatalogRevision: string,
): LeaseDeniedResponse {
  return {
    protocolVersion: AgentProtocolVersion,
    status: 'lease-denied',
    reason,
    contractId,
    latestCatalogRevision,
  }
}

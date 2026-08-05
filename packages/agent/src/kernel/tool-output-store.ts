// 域：工具结果的**当轮句柄化**——超预算的工具输出在进入模型上下文前换成「摘要 + 可召回句柄」。
//
// ## 解决什么问题
// 一次目录列举/长命令输出可能是几十 KB。原样塞进历史，后续每一轮都要重付这笔 token，且很快把窗口
// 撑爆。这里在**结果落进历史之前**把超阈值的输出换成 `ContextRefEnvelope`（含头尾摘要 + `context:recall`
// 的召回参数），全文另存。模型需要时自己召回。
//
// ## 关键不变量（改这些会破什么）
//  - **阈值必须略低于模型档序列化预算，不能更低**。见 `DefaultProjectionChars` 现场注释——曾设成
//    12K（低于预算 32K），结果 12.8K 的输出当轮变存根、再被下游对半砍成 ~4K 头尾拼接，模型连续三次
//    召回也补不齐（真机 9 轮空转取证）。设低了不是"更省"，是让链路自己打架。
//  - **摘要要头尾都留**（`projectSerializedPreview`）：只留头会丢掉命令的结论行/错误行，而那通常正是
//    模型唯一需要的部分。
//  - **切片必须落在字符边界上**：`sliceHeadOnCharacterBoundary` / `sliceTailOnCharacterBoundary` 避免把
//    UTF-16 代理对劈开——劈开会产生非法字符串，某些 provider 直接拒收整条请求。
//  - **`keepOutputInline` 工具跳过整条通道**（见 `tool-materialization`）：有些工具的输出本身就是给
//    模型逐字读的（如结构化契约返回），句柄化会让它永远读不到真内容。
//  - 两种实现只在「全文存哪」上分叉：InMemory 走 toolCallId 的 tool-payload 通道，ContextPayload 走
//    payloadRef。**refKind 必须显式传**——outputId 形如 `session:tool-output:1` 会被前缀推断误判。
import { isFiniteNumber, isString, toNullable, toOptional } from '@velaros-ai/core'
import { AppError } from '@velaros-ai/core/error'

import type {
  ContextPayloadRecord,
  ContextPayloadStore,
} from '../agent/context/ContextPayloadStore'
import { buildContextRefEnvelope, type ContextRefEnvelope } from '../agent/context/contextRefEnvelope'
import { resolveGovernanceSessionKey } from '../agent/context/residency/sessionKey'
import { ToolResultCanonicalizer } from '../agent/context/ToolResultCanonicalizer'

// B3:kernel 页出桩统一为 ContextRefEnvelope(唯一持久化桩;旧 __kernelRef 归档由
// isFoldStubText/normalizeLegacyFoldStub 永久只读兼容)。outputId/hash 归 meta。
export type KernelToolOutputProjection = ContextRefEnvelope

export interface KernelStoredToolOutput {
  outputId: string
  payloadRef?: string
  hash?: string
  sessionId: string
  toolCallId: string
  toolName: string
  output: unknown
  serialized: string
  chars: number
  createdAt: number
  sameAsToolCallId?: string
}

export interface ProjectKernelToolOutputInput {
  sessionId?: LooseOptional<string>
  toolCallId: string
  toolName: string
  output: unknown
}

export interface ProjectKernelToolOutputResult {
  output: unknown
  stored: Nullable<KernelStoredToolOutput>
}

export interface KernelToolOutputStore {
  project(
    input: ProjectKernelToolOutputInput
  ): ProjectKernelToolOutputResult | Promise<ProjectKernelToolOutputResult>
}

export interface InMemoryKernelToolOutputStoreOptions {
  projectionChars?: number
}

export interface ContextPayloadKernelToolOutputStoreOptions {
  projectionChars?: number
}

// 当轮句柄化阈值：低于此值的新鲜结果原样直达模型（模型档序列化预算 32K,见
// toolResultSerialization.ts）。曾为 12_000——比模型档预算还小,导致 12.8K 的目录列表
// 当轮变存根、再被下游对半砍成 ~4K 头尾拼接,模型三连 recall 也补不齐（真机 9 轮空转取证）。
// 保持略低于模型档预算,让超大结果走「摘要+可召回句柄」而非盲目对半砍。
const DefaultProjectionChars = 24_000
const ProjectionTruncationMarker = '...'

function isHighSurrogate(codeUnit: number): boolean {
  return codeUnit >= 0xd800 && codeUnit <= 0xdbff
}

function isLowSurrogate(codeUnit: number): boolean {
  return codeUnit >= 0xdc00 && codeUnit <= 0xdfff
}

function normalizeProjectionChars(value: LooseOptional<number>): number {
  const candidate = value ?? DefaultProjectionChars
  if (!isFiniteNumber(candidate)) return DefaultProjectionChars
  return Math.max(0, Math.floor(candidate))
}

function sliceHeadOnCharacterBoundary(text: string, maxChars: number): string {
  if (maxChars <= 0) return ''

  let end = Math.min(text.length, maxChars)
  if (
    end > 0 &&
    end < text.length &&
    isHighSurrogate(text.charCodeAt(end - 1)) &&
    isLowSurrogate(text.charCodeAt(end))
  ) {
    end -= 1
  }

  return text.slice(0, end)
}

function sliceTailOnCharacterBoundary(text: string, maxChars: number): string {
  if (maxChars <= 0) return ''

  let start = Math.max(0, text.length - maxChars)
  if (
    start > 0 &&
    start < text.length &&
    isLowSurrogate(text.charCodeAt(start)) &&
    isHighSurrogate(text.charCodeAt(start - 1))
  ) {
    start += 1
  }

  return text.slice(start)
}

function projectSerializedPreview(serialized: string, projectionChars: number): string {
  if (projectionChars <= 0) return ''
  if (serialized.length <= projectionChars) return serialized
  if (projectionChars <= ProjectionTruncationMarker.length) return sliceHeadOnCharacterBoundary(serialized, projectionChars)

  const available = projectionChars - ProjectionTruncationMarker.length
  const headChars = Math.ceil(available / 2)
  const tailChars = Math.floor(available / 2)
  return `${sliceHeadOnCharacterBoundary(
    serialized,
    headChars
  )}${ProjectionTruncationMarker}${sliceTailOnCharacterBoundary(serialized, tailChars)}`
}

function serializeOutput(output: unknown): string {
  if (isString(output)) return output

  try {
    return JSON.stringify(output)
  } catch (error) {
    return JSON.stringify({
      error: 'tool_output_serialization_failed',
      reason: AppError.getMessage(error),
    })
  }
}

export class InMemoryKernelToolOutputStore implements KernelToolOutputStore {
  private readonly outputs = new Map<string, KernelStoredToolOutput>()
  private readonly projectionChars: number
  private nextOutputId = 1

  public constructor(options: InMemoryKernelToolOutputStoreOptions = {}) {
    this.projectionChars = normalizeProjectionChars(options.projectionChars)
  }

  public project(input: ProjectKernelToolOutputInput): ProjectKernelToolOutputResult {
    const serialized = serializeOutput(input.output)
    if (serialized.length <= this.projectionChars)
      return {
        output: input.output,
        stored: null,
      }

    const outputId = `${input.sessionId?.trim() || 'session'}:tool-output:${this.nextOutputId}`
    this.nextOutputId += 1
    const stored: KernelStoredToolOutput = {
      outputId,
      sessionId: resolveGovernanceSessionKey(input.sessionId),
      toolCallId: input.toolCallId,
      toolName: input.toolName,
      output: input.output,
      serialized,
      chars: serialized.length,
      createdAt: Date.now(),
    }
    this.outputs.set(outputId, stored)

    // InMemory 店无 payload 落盘:retrieval 走 toolCallId 的 tool-payload 通道
    // (显式 refKind——outputId 形如 session:tool-output:1 会被前缀推断误判,只进 meta)。
    const preview = projectSerializedPreview(serialized, this.projectionChars)
    return {
      output: buildContextRefEnvelope({
        __contextRef: 'tool-output',
        ref: input.toolCallId,
        toolCallId: input.toolCallId,
        toolName: input.toolName,
        excerpt: preview,
        excerptKind: 'head',
        excerptTruncated: serialized.length > preview.length,
        originalLength: serialized.length,
        retrieval: {
          tool: 'context:recall',
          args: { ref: input.toolCallId, refKind: 'tool-payload', reason: 'need full tool output' },
        },
        meta: { outputId },
      }),
      stored,
    }
  }

  public get(outputId: string): Nullable<KernelStoredToolOutput> {
    return toNullable(this.outputs.get(outputId))
  }

  public list(): KernelStoredToolOutput[] {
    return [...this.outputs.values()]
  }
}

export class ContextPayloadKernelToolOutputStore implements KernelToolOutputStore {
  private readonly canonicalizer: ToolResultCanonicalizer
  private readonly projectionChars: number

  public constructor(
    private readonly payloadStore: ContextPayloadStore,
    options: ContextPayloadKernelToolOutputStoreOptions = {}
  ) {
    this.projectionChars = normalizeProjectionChars(options.projectionChars)
    this.canonicalizer = new ToolResultCanonicalizer(this.payloadStore, {
      inlineBudgetChars: this.projectionChars,
    })
  }

  public async project(
    input: ProjectKernelToolOutputInput
  ): Promise<ProjectKernelToolOutputResult> {
    const serialized = serializeOutput(input.output)
    if (serialized.length <= this.projectionChars)
      return {
        output: input.output,
        stored: null,
      }

    const sessionId = resolveGovernanceSessionKey(input.sessionId)
    const canonical = await this.canonicalizer.canonicalize({
      sessionId,
      toolCallId: input.toolCallId,
      toolName: input.toolName,
      serializedResult: serialized,
    })
    const stored = this.toStoredOutput({
      input,
      sessionId,
      serialized,
      record: canonical.record,
      sameAsToolCallId: canonical.visible.sameAsToolCallId,
    })

    const payloadRef = stored.payloadRef ?? stored.outputId
    const preview = projectSerializedPreview(serialized, this.projectionChars)
    const projection = buildContextRefEnvelope({
      __contextRef: 'tool-output',
      ref: payloadRef,
      toolCallId: input.toolCallId,
      toolName: input.toolName,
      payloadRef: stored.payloadRef,
      payloadHash: stored.hash,
      excerpt: preview,
      excerptKind: 'head',
      excerptTruncated: stored.chars > preview.length,
      originalLength: stored.chars,
      retrieval: {
        tool: 'context:recall',
        args: {
          ref: payloadRef,
          refKind: 'payload-ref',
          reason: `need full ${input.toolName} output`,
        },
      },
      meta: {
        outputId: stored.outputId,
        sameAsToolCallId: toOptional(stored.sameAsToolCallId),
      },
    })

    return {
      output: projection,
      stored,
    }
  }

  private toStoredOutput(input: {
    input: ProjectKernelToolOutputInput
    sessionId: string
    serialized: string
    record: ContextPayloadRecord
    sameAsToolCallId?: string
  }): KernelStoredToolOutput {
    const stored: KernelStoredToolOutput = {
      outputId: input.record.payloadRef,
      payloadRef: input.record.payloadRef,
      hash: input.record.hash,
      sessionId: input.sessionId,
      toolCallId: input.input.toolCallId,
      toolName: input.input.toolName,
      output: input.input.output,
      serialized: input.serialized,
      chars: input.record.chars,
      createdAt: input.record.createdAt,
    }
    if (input.sameAsToolCallId) {
      stored.sameAsToolCallId = input.sameAsToolCallId
    }
    return stored
  }
}

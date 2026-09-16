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
//  - **含源码窗口的结果不能头尾裁剪**：一次批量 `project:read` 序列化后超过阈值时，头尾拼接会把
//    中间几个文件连同 JSON 结构一起切掉，模型既看不到源码也拿不到续读引用（真机 2026-09-13 取证：
//    六文件读取 27.9K 字符被裁成 24K 残片，模型只能重读）。这类结果按整行分页收进预算，结构保持完整，
//    每个窗口自带 `continuation`；完整输出照常归档，仍可召回。
//  - 两种实现只在「全文存哪」上分叉：InMemory 走 toolCallId 的 tool-payload 通道，ContextPayload 走
//    payloadRef。**refKind 必须显式传**——outputId 形如 `session:tool-output:1` 会被前缀推断误判。
import { toNullable } from '@velaros-ai/core'

import type {KernelToolOutputStore } from '../../contract/requires.js'
import type {KernelStoredToolOutput, ProjectKernelToolOutputInput, ProjectKernelToolOutputResult } from '../../types/tools.js'
import { buildContextRefEnvelope } from '../../utils/context/context-ref-envelope'
import { resolveGovernanceSessionKey } from '../../utils/residency/session-key'
import { fitSourceWindowsWithinProjection, normalizeProjectionChars, projectSerializedPreview, serializeOutput } from '../../utils/tools/tool-output-store'

export interface InMemoryKernelToolOutputStoreOptions {
  projectionChars?: number
}




















export class InMemoryKernelToolOutputStore implements KernelToolOutputStore {
  private readonly outputs = new Map<string, KernelStoredToolOutput>()
  private readonly projectionChars: number
  private nextOutputId = 1

  public constructor(options: InMemoryKernelToolOutputStoreOptions = {}) {
    this.projectionChars = normalizeProjectionChars(options.projectionChars)
  }

  public project(input: ProjectKernelToolOutputInput): ProjectKernelToolOutputResult {
    const output = toNullable(input.output)
    const serialized = serializeOutput(output)
    if (serialized.length <= this.projectionChars)
      return {
        output,
        stored: null,
      }

    const outputId = `${input.sessionId?.trim() || 'session'}:tool-output:${this.nextOutputId}`
    this.nextOutputId += 1
    const stored: KernelStoredToolOutput = {
      outputId,
      sessionId: resolveGovernanceSessionKey(input.sessionId),
      toolCallId: input.toolCallId,
      toolName: input.toolName,
      output,
      serialized,
      chars: serialized.length,
      createdAt: Date.now(),
    }
    this.outputs.set(outputId, stored)

    const fitted = fitSourceWindowsWithinProjection(output, this.projectionChars)
    if (fitted) return { output: fitted.output, stored }

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



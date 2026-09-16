import { toNullable, toOptional } from '@velaros-ai/core'

import type { ContextPayloadStore, KernelToolOutputStore } from '../../contract/requires.js'
import type { ContextPayloadKernelToolOutputStoreOptions, ProjectKernelToolOutputInput, ProjectKernelToolOutputResult } from '../../types/tools.js'
import { buildContextRefEnvelope } from '../../utils/context/context-ref-envelope'
import { resolveGovernanceSessionKey } from '../../utils/residency/session-key'
import { buildStoredToolOutput, fitSourceWindowsWithinProjection, normalizeProjectionChars, projectSerializedPreview, serializeOutput } from '../../utils/tools/tool-output-store'
import { ToolResultCanonicalizer } from '../context/ToolResultCanonicalizer'

/**
 * 落盘版工具输出店：全文交给宿主的 `ContextPayloadStore` 归档，模型侧只留摘要与 payloadRef。
 *
 * 宿主注入了 payload 店时，`ToolExecutor` 为每条执行链建一份；同一段正文按内容哈希去重，
 * 重复输出只留一份原文，回执里用 `sameAsToolCallId` 指回最早那次。
 */
export interface ContextPayloadKernelToolOutputStoreApi extends KernelToolOutputStore {}

export class ContextPayloadKernelToolOutputStore implements ContextPayloadKernelToolOutputStoreApi {
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
    const output = toNullable(input.output)
    const serialized = serializeOutput(output)
    if (serialized.length <= this.projectionChars)
      return {
        output,
        stored: null,
      }

    const sessionId = resolveGovernanceSessionKey(input.sessionId)
    const canonical = await this.canonicalizer.canonicalize({
      sessionId,
      toolCallId: input.toolCallId,
      toolName: input.toolName,
      serializedResult: serialized,
    })
    const stored = buildStoredToolOutput({
      input: { ...input, output },
      sessionId,
      serialized,
      record: canonical.record,
      sameAsToolCallId: canonical.visible.sameAsToolCallId,
    })

    const fitted = fitSourceWindowsWithinProjection(output, this.projectionChars)
    if (fitted) return { output: fitted.output, stored }

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
}

import { toNullable, toOptional } from '@velaros-ai/core'

import type { ContextPayloadStore, KernelToolOutputStore } from '../../contract/requires.js'
import type { ContextPayloadRecord } from '../../types/context.js'
import type { ContextPayloadKernelToolOutputStoreOptions, KernelStoredToolOutput, ProjectKernelToolOutputInput, ProjectKernelToolOutputResult } from '../../types/tools.js'
import { buildContextRefEnvelope } from '../../utils/context/context-ref-envelope'
import { resolveGovernanceSessionKey } from '../../utils/residency/session-key'
import { fitSourceWindowsWithinProjection, normalizeProjectionChars, projectSerializedPreview, serializeOutput } from '../../utils/tools/tool-output-store'
import { ToolResultCanonicalizer } from '../context/ToolResultCanonicalizer'

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
    const stored = this.toStoredOutput({
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

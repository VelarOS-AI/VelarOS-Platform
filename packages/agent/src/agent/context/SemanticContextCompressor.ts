import type { ModelMessage } from 'ai'

import { isArray, isEmpty,isRecord, isString, Log } from '@velaros-ai/core'

export interface SemanticCompressionPayloadManifest {
  handleId: string
  summary: string
}

interface BuildSemanticCompressionPromptInput {
  targetChars: number
  olderMessages: ModelMessage[]
  payloadManifests: SemanticCompressionPayloadManifest[]
}

function buildSemanticCompressionPrompt(input: BuildSemanticCompressionPromptInput): string {
  const payloads = input.payloadManifests
    .map((manifest) => `- ${manifest.handleId}: ${manifest.summary}`)
    .join('\n')
  const olderMessages = JSON.stringify(input.olderMessages)

  return [
    'Compress the conversation context for a coding agent.',
    `Target summary size: <= ${input.targetChars} characters.`,
    'Return strict JSON only, with these string or string-array fields:',
    'summary, retainedHandles, droppedHandles, decisions, openTasks, verificationState, risks.',
    '',
    'Payload handles:',
    payloads || '(none)',
    '',
    'Older messages JSON:',
    olderMessages,
  ].join('\n')
}

export interface SemanticContextCompressorOptions {
  summarize: (input: {
    prompt: string
    signal: AbortSignal
  }) => Promise<string>
}

export interface SemanticContextCompressInput {
  targetChars: number
  olderMessages: ModelMessage[]
  payloadManifests: SemanticCompressionPayloadManifest[]
  signal: AbortSignal
}

export interface SemanticContextCompressionResult {
  ok: boolean
  summary: string
  retainedHandles: string[]
  droppedHandles: string[]
  decisions: string[]
  openTasks: string[]
  verificationState: string[]
  risks: string[]
  fallbackReason?: string
}

interface ParsedCompressionJson {
  summary: string
  retainedHandles: string[]
  droppedHandles: string[]
  decisions: string[]
  openTasks: string[]
  verificationState: string[]
  risks: string[]
}

function readStringArray(record: Record<string, unknown>, key: keyof ParsedCompressionJson): string[] {
  const value = record[key]

  if (!isArray(value)) return []

  return value.filter((entry): entry is string => isString(entry))
}

function parseCompressionJson(text: string): Nullable<ParsedCompressionJson> {
  let parsed: unknown

  try {
    parsed = JSON.parse(text)
  } catch (error) {
    Log.tag('SemanticContextCompressor').warn('semantic compression JSON parse failed, skipping payload', { error })
    return null
  }

  if (!isRecord(parsed) || !isString(parsed.summary)) return null

  return {
    summary: parsed.summary.trim(),
    retainedHandles: readStringArray(parsed, 'retainedHandles'),
    droppedHandles: readStringArray(parsed, 'droppedHandles'),
    decisions: readStringArray(parsed, 'decisions'),
    openTasks: readStringArray(parsed, 'openTasks'),
    verificationState: readStringArray(parsed, 'verificationState'),
    risks: readStringArray(parsed, 'risks'),
  }
}

function fallbackSummary(input: SemanticContextCompressInput, reason: string): SemanticContextCompressionResult {
  const retainedHandles = input.payloadManifests.map((manifest) => manifest.handleId)
  const summary = [
    'Deterministic context compression fallback.',
    `Older messages: ${input.olderMessages.length}.`,
    !isEmpty(retainedHandles)
      ? `Retained payload handles: ${retainedHandles.join(', ')}.`
      : 'Retained payload handles: none.',
  ].join('\n')

  return {
    ok: false,
    summary,
    retainedHandles,
    droppedHandles: [],
    decisions: [],
    openTasks: [],
    verificationState: ['Semantic compressor fallback was used.'],
    risks: [reason],
    fallbackReason: reason,
  }
}

export class SemanticContextCompressor {
  public constructor(private readonly options: SemanticContextCompressorOptions) {}

  public async compress(input: SemanticContextCompressInput): Promise<SemanticContextCompressionResult> {
    const targetChars = Math.max(1, Math.floor(input.targetChars))
    const prompt = buildSemanticCompressionPrompt({
      targetChars,
      olderMessages: input.olderMessages,
      payloadManifests: input.payloadManifests,
    })
    const text = await this.options.summarize({ prompt, signal: input.signal })
    const parsed = parseCompressionJson(text)

    if (!parsed || isEmpty(parsed.summary)) return fallbackSummary(input, 'model compression returned invalid JSON')

    if (parsed.summary.length > targetChars) return fallbackSummary(input, 'model compression exceeded target size')

    return {
      ok: true,
      summary: parsed.summary,
      retainedHandles: parsed.retainedHandles,
      droppedHandles: parsed.droppedHandles,
      decisions: parsed.decisions,
      openTasks: parsed.openTasks,
      verificationState: parsed.verificationState,
      risks: parsed.risks,
    }
  }
}

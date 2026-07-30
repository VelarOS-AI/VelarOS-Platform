import type { ToolSet } from 'ai'

import { isNonBlankString } from '@velaros-ai/core'

import { AiSdkModelRequestTransport } from './AiSdkModelRequestTransport'
import type { ModelRequestOptions } from './ModelContracts'
import { applyModelRequestPolicy } from './ModelRequestPolicy'
import type {
  ModelRequestGenerateText,
  ModelRequestLanguageModel,
  ModelRequestObjectInput,
  ModelRequestOpenStreamInput,
  ModelRequestStreamText,
  ModelRequestStreamTextInput,
  ModelRequestStreamTextInputToString,
  ModelRequestStreamTextResult,
  ModelRequestTextInput,
  ModelRequestTransport,
} from './ModelRequestTypes'

export interface ModelRequestClientOptions {
  transport?: ModelRequestTransport
  generateText?: ModelRequestGenerateText
  streamText?: ModelRequestStreamText
}

/** @deprecated 使用名称更准确的 {@link ModelRequestClientOptions}。 */
export type ModelRequestServiceOptions = ModelRequestClientOptions

interface ObjectAuxiliaryRequest<TOutput> {
  model: ModelRequestLanguageModel
  prompt: string
  schema: unknown
  schemaName: string
  schemaDescription: string
  maxRetries?: ModelRequestObjectInput<TOutput>['maxRetries']
  modelRequestOptions?: ModelRequestOptions
  abortSignal?: ModelRequestObjectInput<TOutput>['abortSignal']
  mapOutput?: (output: unknown) => TOutput
}

interface TextStreamAuxiliaryRequest {
  model: ModelRequestStreamTextInput['model']
  maxRetries?: ModelRequestStreamTextInput['maxRetries']
  maxOutputTokens?: ModelRequestStreamTextInput['maxOutputTokens']
  modelRequestOptions?: ModelRequestOptions
  abortSignal?: ModelRequestStreamTextInput['abortSignal']
  onError?: ModelRequestStreamTextInput['onError']
  stopWhen?: (text: string) => boolean
}

interface TranslateThinkingTextRequest extends TextStreamAuxiliaryRequest {
  sourceText: string
  targetLanguage: string
}

interface GenerateGitCommitMessageRequest extends TextStreamAuxiliaryRequest {
  prompt: string
  locale: string
}

interface GenerateSessionHandoffBriefRequest extends TextStreamAuxiliaryRequest {
  transcript: string
  workspaceHint?: string
  locale: string
}

interface GenerateChatSuggestionsRequest<TOutput> extends ObjectAuxiliaryRequest<TOutput> {
  phase: 'new-session' | 'next-turn'
  locale: string
}

interface GenerateInlineCompletionRequest extends TextStreamAuxiliaryRequest {
  /** 已构造好的补全提示词（含前后文与语言/文件信息）。 */
  prompt: string
}

interface ContextSemanticSummaryRequest {
  model: ModelRequestLanguageModel
  system: string
  prompt: string
  abortSignal?: ModelRequestTextInput['abortSignal']
  maxOutputTokens?: ModelRequestTextInput['maxOutputTokens']
  modelRequestOptions?: ModelRequestOptions
}

/**
 * 通用模型请求客户端。
 *
 * 宿主只需注入 `ModelRequestTransport`；endpoint 是调用方定义的可观测标签，不要求
 * 使用任何 VelarOS 产品协议。
 */
class ModelRequestClient {
  protected readonly transport: ModelRequestTransport

  constructor(options: ModelRequestClientOptions = {}) {
    this.transport =
      options.transport ??
      new AiSdkModelRequestTransport({
        generateText: options.generateText,
        streamText: options.streamText,
      })
  }

  public async generateText(input: ModelRequestTextInput): Promise<string> {
    const { endpoint, modelRequestOptions, ...request } = input
    const result = await this.transport.generateText({
      endpoint,
      request: applyModelRequestPolicy(request, modelRequestOptions),
    })
    return result.text
  }

  public streamText<TToolSet extends ToolSet = ToolSet>(
    input: ModelRequestOpenStreamInput<TToolSet>,
    modelRequestOptions?: ModelRequestOptions
  ): ModelRequestStreamTextResult<TToolSet> {
    const { endpoint, ...request } = input
    return this.transport.streamText<TToolSet>({
      endpoint,
      request: applyModelRequestPolicy(
        request as ModelRequestStreamTextInput<TToolSet>,
        modelRequestOptions
      ),
    })
  }

  public async generateObject<TOutput = unknown>(
    input: ModelRequestObjectInput<TOutput>
  ): Promise<TOutput> {
    const result = await this.transport.generateText({
      endpoint: input.endpoint,
      request: applyModelRequestPolicy(
        {
          model: input.model,
          system: input.system,
          messages: input.messages,
          output: this.transport.createObjectOutput({
            schema: input.schema,
            schemaName: input.schemaName,
            schemaDescription: input.schemaDescription,
          }),
          maxRetries: input.maxRetries,
          maxOutputTokens: input.maxOutputTokens,
          abortSignal: input.abortSignal,
        },
        input.modelRequestOptions
      ),
    })

    return input.mapOutput ? input.mapOutput(result.output) : (result.output as TOutput)
  }

  public async collectTextStream(
    input: ModelRequestStreamTextInputToString
  ): Promise<string> {
    const { modelRequestOptions, stopWhen, ...streamInput } = input
    const stream = this.streamText(streamInput, modelRequestOptions)

    let text = ''
    for await (const chunk of stream.textStream) {
      text += chunk
      if (stopWhen?.(text)) break
    }

    return text
  }
}

/**
 * 向后兼容的 VelarOS 高层场景服务。
 *
 * @deprecated 该类包含 Workbench、Memory 与聊天等产品场景方法，将从 Model 包迁出。
 * 通用调用请使用 {@link ModelRequestClient}；产品场景请在宿主层组合 endpoint 与 prompt。
 */
class ModelRequestService extends ModelRequestClient {
  public createChatQaMemoryDraft<TOutput = unknown>(
    input: ObjectAuxiliaryRequest<TOutput>
  ): Promise<TOutput> {
    const { prompt, ...request } = input
    return this.generateObject({
      endpoint: 'memory.chat-qa-draft',
      system: [
        '你是一个记忆整理助手，负责把聊天问答或连续多轮对话窗口提炼成可长期复用的记忆。',
        '只保留将来有用的事实、偏好、决策、步骤、命令、约束或结论；不要记录寒暄和一次性过程噪声。',
        '使用原始对话的主要语言输出。',
      ].join('\n'),
      messages: [{ role: 'user', content: prompt }],
      ...request,
    })
  }

  public curateMemoryDrafts<TOutput = unknown>(
    input: ObjectAuxiliaryRequest<TOutput>
  ): Promise<TOutput> {
    const { prompt, ...request } = input
    return this.generateObject({
      endpoint: 'memory.curation',
      system: [
        '你是生产环境的记忆清洗助手，负责把原始输入整理成边界清晰、可长期复用的记忆记录。',
        '只保留稳定事实、偏好、决策、约束、纠错、项目/任务上下文和未来可复用步骤；删除寒暄、重复、临时过程、猜测、密钥凭据和敏感原文。',
        '同一主题合并压缩成一条；不同主题拆成多条。每条记忆必须有单一主题和清楚边界。',
        '分层：session=本会话/短期过程，task=具体任务，project=项目范围事实与约定，user=跨项目偏好；禁止输出 knowledge 等非列枚举值。',
        '使用原输入的主要语言输出。按结构化 schema 返回对象，不要输出 Markdown 代码块或额外解释。',
      ].join('\n'),
      messages: [{ role: 'user', content: prompt }],
      ...request,
    })
  }

  public selectRelevantMemories<TOutput = unknown>(
    input: ObjectAuxiliaryRequest<TOutput>
  ): Promise<TOutput> {
    const { prompt, ...request } = input
    return this.generateObject({
      endpoint: 'memory.relevance-select',
      system: [
        'You select which stored memories will be useful for processing the user query.',
        'You are given the query, a list of candidate memories (id, title, summary), and recently used tools.',
        'Return the ids of memories that are clearly useful (up to the requested maximum), ordered most relevant first.',
        '- Be selective: if you are unsure a memory helps, leave it out. Returning an empty list is fine.',
        '- If a memory is just usage reference / API docs for a recently used tool, do NOT select it — the tool is already in use.',
        '- DO still select memories containing warnings, gotchas, or known issues about those tools; active use is exactly when those matter.',
        'Return structured JSON only.',
      ].join('\n'),
      messages: [{ role: 'user', content: prompt }],
      ...request,
    })
  }

  public generateScheduleRule<TOutput = unknown>(
    input: ObjectAuxiliaryRequest<TOutput>
  ): Promise<TOutput> {
    const { prompt, ...request } = input
    return this.generateObject({
      endpoint: 'scheduler.rule-generate',
      system: [
        'You convert a user\'s natural-language schedule request into one RFC 5545 RRULE body.',
        'Return one RRULE body only (no "RRULE:" prefix, no DTSTART/RDATE/EXDATE/timezone — the app stores start time and timezone separately).',
        'Prefer constructs supported by rrule.js: FREQ, INTERVAL, BYDAY, BYMONTHDAY, BYHOUR, BYMINUTE, BYSECOND, COUNT.',
        '- "every N minutes" -> FREQ=MINUTELY;INTERVAL=N; "every N hours" -> FREQ=HOURLY;INTERVAL=N.',
        '- "every Wednesday" -> FREQ=WEEKLY;BYDAY=WE; "every weekday at 9am" -> FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR;BYHOUR=9;BYMINUTE=0.',
        '- "1st of each month at 10:00" -> FREQ=MONTHLY;BYMONTHDAY=1;BYHOUR=10;BYMINUTE=0.',
        '- Use BYHOUR/BYMINUTE only when the user states an explicit time. Do not use COUNT/UNTIL unless the user asks for a finite/ending schedule.',
        'If the input is NOT about a schedule, recurrence, time, date, or cadence, return status "unknown", rrule null, and a short description saying so.',
        'Otherwise return status "ok". The description must be a concise natural-language interpretation of the rule, in the same language as the user input.',
        'Return structured JSON only.',
      ].join('\n'),
      messages: [{ role: 'user', content: prompt }],
      ...request,
    })
  }

  public planSubAgentGuidanceRelay<TOutput = unknown>(
    input: ObjectAuxiliaryRequest<TOutput>
  ): Promise<TOutput> {
    const { prompt, ...request } = input
    return this.generateObject({
      endpoint: 'agent.sub-agent-guidance-relay',
      system: [
        'You are the coordinating main agent in a multi-threaded desktop coding assistant.',
        'The user appended non-blocking guidance while sub-agents are still running.',
        'Interpret the guidance, then produce relay messages for only the relevant active sub-agents.',
        'Never copy the user guidance verbatim into relay messages.',
        'Return structured JSON only.',
      ].join('\n'),
      messages: [{ role: 'user', content: prompt }],
      ...request,
    })
  }

  public translateThinkingText(input: TranslateThinkingTextRequest): Promise<string> {
    const { sourceText, targetLanguage, ...request } = input
    return this.collectTextStream({
      endpoint: 'chat.thinking-translation',
      system: [
        'You translate model reasoning text for display in a desktop chat UI.',
        `Translate the input into ${targetLanguage}.`,
        'Return only the translated text. Do not summarize, explain, redact, add markdown fences, or change code/path/API literals.',
        'Preserve line breaks and list structure as much as possible.',
      ].join('\n'),
      messages: [{ role: 'user', content: sourceText }],
      ...request,
    })
  }

  public generateGitCommitMessage(input: GenerateGitCommitMessageRequest): Promise<string> {
    const { prompt, locale, ...request } = input
    return this.collectTextStream({
      endpoint: 'system.git-commit-message',
      system: [
        'You write concise Git commit subject lines.',
        'Return exactly one line. Do not wrap it in quotes. Do not output markdown.',
        'Use imperative mood when writing English. Keep it under 72 characters.',
        locale === 'zh-CN'
          ? 'Prefer concise Simplified Chinese unless the changed files are clearly English-only.'
          : 'Prefer concise English unless the changed files are clearly Chinese-only.',
      ].join('\n'),
      messages: [{ role: 'user', content: prompt }],
      ...request,
    })
  }

  public generateInlineCompletion(input: GenerateInlineCompletionRequest): Promise<string> {
    const { prompt, ...request } = input
    return this.collectTextStream({
      endpoint: 'workbench.inline-completion',
      system: [
        'You are an inline code completion engine embedded in a code editor (like Cursor/Copilot).',
        'Continue the code exactly at the cursor marked by <|cursor|>.',
        'Output ONLY the raw text to insert at the cursor. No explanations, no comments about your answer, no markdown code fences.',
        'Do not repeat code that already appears before the cursor, and do not restate the code after the cursor.',
        'Prefer completing the current statement or block; keep indentation consistent with the surrounding code.',
        'If no meaningful completion is possible, return an empty string.',
      ].join('\n'),
      messages: [{ role: 'user', content: prompt }],
      ...request,
    })
  }

  public generateSessionHandoffBrief(input: GenerateSessionHandoffBriefRequest): Promise<string> {
    const { transcript, workspaceHint, locale, ...request } = input
    const language = locale === 'zh-CN' ? 'Simplified Chinese' : 'English'
    const workspaceLine = isNonBlankString(workspaceHint)
      ? `The continuation runs in this workspace: ${workspaceHint}.`
      : 'The continuation runs in a fresh session in the same workspace.'
    return this.collectTextStream({
      endpoint: 'chat.session-handoff-brief',
      system: [
        'You write a concise handoff brief so a FRESH chat session can continue an unfinished task without the prior conversation.',
        `Write in ${language}.`,
        workspaceLine,
        'Structure the brief with short sections: Goal, Done so far, Open threads / next steps, Key decisions & constraints.',
        'Be specific: keep file paths, commands, identifiers, and URLs verbatim. Do not invent facts not present in the input.',
        'Write it as a direct instruction to the new session (second person). No preamble, no markdown code fences.',
        'Keep it under ~350 words.',
      ].join('\n'),
      messages: [{ role: 'user', content: transcript }],
      ...request,
    })
  }

  public generateChatSuggestions<TOutput = unknown>(
    input: GenerateChatSuggestionsRequest<TOutput>
  ): Promise<TOutput> {
    const { prompt, phase, locale, ...request } = input
    const language = locale === 'zh-CN' ? 'Simplified Chinese' : 'English'
    const phaseGuidance =
      phase === 'new-session'
        ? [
            'Infer a few useful things the user may want to do now from the supplied long-term memories.',
            'Only suggest intentions strongly supported by multiple memories. Do not expose private memory details or pretend certainty.',
          ]
        : [
            'Suggest the most likely useful next actions after the completed assistant turn in the supplied recent conversation.',
            'Do not repeat work that the assistant already completed. Prefer concrete continuation, verification, review, or follow-up actions.',
            'Each prompt is shown directly as a one-line composer completion. Make it concise and actionable; do not write a heading plus description inside the prompt.',
          ]

    return this.generateObject({
      endpoint: `chat.suggestions.${phase}`,
      system: [
        'You generate short, optional suggestion cards for a desktop chat composer.',
        `Write in ${language}.`,
        ...phaseGuidance,
        'Return 2 to 4 suggestions ordered by estimated likelihood, highest first.',
        'Each prompt must be a complete first-person user message that can be sent as-is.',
        'Keep titles short, reasons to one short sentence, and confidence between 0 and 1.',
        'Return structured JSON only. Never include markdown fences.',
      ].join('\n'),
      messages: [{ role: 'user', content: prompt }],
      ...request,
    })
  }

  public summarizeContextSemantics(input: ContextSemanticSummaryRequest): Promise<string> {
    return this.generateText({
      endpoint: 'agent.context-semantic-summary',
      model: input.model,
      system: input.system,
      prompt: input.prompt,
      abortSignal: input.abortSignal,
      maxOutputTokens: input.maxOutputTokens,
      modelRequestOptions: input.modelRequestOptions,
    })
  }

  public openAgentStreamTurn<TToolSet extends ToolSet = ToolSet>(
    input: ModelRequestStreamTextInput<TToolSet>
  ): ModelRequestStreamTextResult<TToolSet> {
    return this.transport.streamText<TToolSet>({
      endpoint: 'agent.stream-turn',
      request: input,
    })
  }

  public openAgentQueryTurn<TToolSet extends ToolSet = ToolSet>(
    input: ModelRequestStreamTextInput<TToolSet>
  ): ModelRequestStreamTextResult<TToolSet> {
    return this.transport.streamText<TToolSet>({
      endpoint: 'agent.query-turn',
      request: input,
    })
  }

  public openPureChatStream(
    input: ModelRequestStreamTextInput
  ): ModelRequestStreamTextResult {
    return this.transport.streamText({
      endpoint: 'chat.pure-turn',
      request: input,
    })
  }

}

export { ModelRequestClient, ModelRequestService }

import type { ActDecodedTurn, ActPreview, ActTurnDecoder } from '@velaros-ai/agent'
import { isEmpty, optionalWhenLazy } from '@velaros-ai/core'
import { AppError } from '@velaros-ai/core/error'
import {
  modelRequestEncoder,
  type ModelResponseFormat,
  type ModelToolCall,
} from '@velaros-ai/kernel'

import { NativeExecutionSchema } from '../contract/surface.js'
import type { NativeExecutionInput } from '../types/native-tools.js'
import type { ScriptProtocolOptions } from '../types/runtime.js'
import { protocolConfig } from '../utils/script-protocol.js'

/** 普通工具调用只描述程序，执行仍经过完整响应接收和持久化门。 */
export interface NativeTurnDecoderApi extends ActTurnDecoder {}

export class NativeTurnDecoder implements NativeTurnDecoderApi {
  public readonly instructions: string
  public readonly response: ModelResponseFormat
  private readonly config
  private text = ''
  private calls: ModelToolCall[] = []
  private chars = 0
  private ended = false

  public constructor(options: ScriptProtocolOptions = {}) {
    this.config = protocolConfig(options)
    this.instructions =
      '通过 exec 执行 JavaScript ESM，命令用 execa，文件用 Node 标准库，差异用 diff。依赖步骤在同一程序中顺序 await；检查执行结果后继续，任务完成时用普通文本答复。'
    this.response = {
      type: 'tools',
      tools: [
        {
          name: 'exec',
          description:
            '在工作目录执行 JavaScript ESM，支持顶层 await、Node 标准库、预装 npm 包和按需导入的应用能力。console.log 返回输出。',
          schema: NativeExecutionSchema,
        },
      ],
    }
  }

  public reset(): void {
    this.text = ''
    this.calls = []
    this.chars = 0
    this.ended = false
  }

  public push(text: string): readonly ActPreview[] {
    this.consume(text.length)
    this.text += text
    return [{ type: 'text', text }]
  }

  public acceptTool(call: ModelToolCall): readonly ActPreview[] {
    this.consume(JSON.stringify(call).length)
    if (
      !this.config.allowed.includes('execute') ||
      call.name !== 'exec' ||
      !call.id ||
      call.id.length > 256 ||
      this.calls.some((item) => item.id === call.id) ||
      this.calls.length >= this.config.maxBlocks
    )
      throw new AppError('SCRIPT_PROTOCOL', '原生执行入口或调用身份无效')
    let input: NativeExecutionInput
    try {
      input = modelRequestEncoder.output(
        { type: 'json', name: call.name, description: '执行源码', schema: NativeExecutionSchema },
        call.input
      ) as NativeExecutionInput
    } catch (error) {
      throw new AppError(
        'SCRIPT_PROTOCOL',
        `工具入参需要 code 字符串：${error instanceof Error ? error.message : String(error)}`
      )
    }
    const index = this.calls.length
    this.calls.push({ ...call, input })
    const kind = 'execute'
    return [
      { type: 'program', index, kind, phase: 'start', text: '' },
      { type: 'program', index, kind, phase: 'delta', text: input.code },
      { type: 'program', index, kind, phase: 'end', text: '' },
    ]
  }

  public finish(): ActDecodedTurn {
    this.consume(0)
    this.ended = true
    if (isEmpty(this.calls) && !this.text.trim())
      throw new AppError('SCRIPT_PROTOCOL', '模型响应为空')
    return {
      message: this.text,
      done: isEmpty(this.calls),
      submission: optionalWhenLazy(!isEmpty(this.calls), () => ({
        executions: this.calls.map((call) => ({
          async: false,
          program: {
            language: 'node',
            source: (call.input as NativeExecutionInput).code,
            retainTurns: this.config.defaultRetain,
          },
        })),
      })),
      events: [],
    }
  }

  private consume(chars: number): void {
    if (this.ended) throw new AppError('SCRIPT_PROTOCOL', '完整响应只能接收一次')
    this.chars += chars
    if (this.chars > this.config.maxChars)
      throw new AppError('SCRIPT_PROTOCOL', '响应超过协议字符预算')
  }
}

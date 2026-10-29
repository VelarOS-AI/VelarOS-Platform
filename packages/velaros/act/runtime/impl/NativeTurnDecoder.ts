import type { ActDecodedTurn, ActPreview, ActTurnDecoder } from '@velaros-ai/agent'
import { isEmpty, isUndefined, optionalWhen } from '@velaros-ai/core'
import {
  modelRequestEncoder,
  type ModelResponseFormat,
  type ModelToolCall,
} from '@velaros-ai/kernel'

import { GoalLimits } from '../../system/contract/constants.js'
import {
  NativeBlobSchema,
  NativeDoneSchema,
  NativeExecutionSchema,
  NativeObservationSchema,
} from '../contract/surface.js'
import type {
  NativeBlobInput,
  NativeDoneInput,
  NativeExecutionInput,
  NativeObservationInput,
} from '../types/native-tools.js'
import type { ScriptProtocolRecord } from '../types/program.js'
import type { ScriptProtocolOptions } from '../types/runtime.js'
import { nativeToolName } from '../utils/native-protocol.js'
import { scriptInputCopy } from '../utils/program-context.js'
import { protocolConfig, protocolFailure } from '../utils/script-protocol.js'
import { compileScriptRecords } from '../utils/script-records.js'

/** 原生 JSON 与文本传输共用声明语义；完整响应通过后才执行。 */
export interface NativeTurnDecoderApi extends ActTurnDecoder {}

export class NativeTurnDecoder implements NativeTurnDecoderApi {
  public readonly instructions: string
  public readonly response: ModelResponseFormat
  private readonly config
  private readonly inputs: Readonly<Record<string, unknown>>
  private text = ''
  private calls: ModelToolCall[] = []
  private records: ScriptProtocolRecord[] = []
  private done = false
  private completion?: string
  private chars = 0
  private ended = false

  public constructor(
    options: ScriptProtocolOptions = {},
    inputs: Readonly<Record<string, unknown>> = {},
    private readonly canFinishText: () => boolean = () => true
  ) {
    this.config = protocolConfig(options)
    this.inputs = scriptInputCopy(inputs)
    const name = (kind: ScriptProtocolRecord['kind'] | 'done') => nativeToolName(kind, this.config)
    if (new Set(this.config.allowed.map(name)).size !== this.config.allowed.length)
      throw protocolFailure('原生工具名称必须唯一')
    const descriptions = {
      execute:
        '执行一次程序。code 写 JavaScript 逻辑；复制或转换已有内容时，直接读取来源，在程序内由该值生成输出及校验预期。options.blobs 传递新写的文档、补丁和源码片段，通过 import {blobs} from "velaros:program" 读取，独立于 JavaScript 字面量编码。省略 options.async 使用短等待返回；true 立即后台，false 优先等待完成；新输入、并行程序收束或子任务进展会提前返回执行身份，原程序继续。options.retain 控制结果保留。等待已有执行完成时，用空 code 与 options.control:{kind:"wait",executionId,waitMs:60000}；单次等待 1..60000 毫秒，默认 60000，到期返回当前状态，目标继续运行，无需循环 read 或运行定时器。检查/停止用 kind:"read"/"stop"；read/wait 可加 cursor/limit。每次只受理一个等待，等待与检查/停止通道独立，普通执行槽满时仍可用。依赖步骤顺序 await；检查执行结果后继续。',
      observe:
        '登记或整体替换当前持续只读观察，下个正常业务轮运行；每份响应最多一次。options.clear:true 退订，options.edits 局部修改；引用、编辑、快照或清除时 code 为 ""。',
      blobs:
        'JSON 参数 name/text 绑定原文，必须在同一响应同时提交使用它的程序调用。单独调用不会执行或保留原文；一次程序优先把原文放进该调用的 options.blobs。',
      done: '通过 JSON 参数 message 返回用户答复，completion 提供完成依据。作为本响应最后一个工具调用，申请运行时验收任务完成。',
    }
    this.response = {
      type: 'tools',
      tools: this.config.allowed.map((kind) => ({
        name: name(kind),
        description: descriptions[kind],
        schema:
          kind === 'done'
            ? NativeDoneSchema
            : kind === 'blobs'
              ? NativeBlobSchema
              : kind === 'observe'
                ? NativeObservationSchema
                : NativeExecutionSchema,
      })),
    }
    this.instructions = [
      '需要操作时通过原生工具提交，参数按各自 JSON Schema 填写。已有执行或子任务仍在运行、当前只需等待时，仅返回普通文本进度；运行时挂起模型调用，待执行进展、子任务结果或新输入后恢复。',
      this.config.allowed.includes('done')
        ? `普通答复可以直接返回文本，无需工具调用。无后台工作时按正常答复进入完成校验；有活动目标时用 ${name('done')} 的 completion 提交完成依据。`
        : '',
      !isEmpty(Object.keys(this.inputs))
        ? `宿主参数可通过 options.inputRef 引用：${Object.keys(this.inputs)
            .map((key) => `host:${key}`)
            .join('、')}。`
        : '',
    ]
      .filter(Boolean)
      .join('\n')
  }

  public reset(): void {
    this.text = ''
    this.calls = []
    this.records = []
    this.done = false
    this.completion = undefined
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
    const kind = this.config.allowed.find((kind) => nativeToolName(kind, this.config) === call.name)
    if (!kind || !call.id || call.id.length > 256 || this.calls.some((item) => item.id === call.id))
      throw protocolFailure('原生执行入口或调用身份无效')
    if (this.done) throw protocolFailure('完成声明之后不能再声明控制操作')
    if (kind !== 'done' && this.records.length >= this.config.maxBlocks)
      throw protocolFailure('程序与原文调用数量超过预算')
    const schema =
      kind === 'done'
        ? NativeDoneSchema
        : kind === 'blobs'
          ? NativeBlobSchema
          : kind === 'observe'
            ? NativeObservationSchema
            : NativeExecutionSchema
    let input: NativeExecutionInput | NativeObservationInput | NativeBlobInput | NativeDoneInput
    try {
      input = modelRequestEncoder.output(
        { type: 'json', name: call.name, description: '控制声明', schema },
        call.input
      ) as typeof input
    } catch (error) {
      throw protocolFailure(
        `工具入参不符合声明合同：${error instanceof Error ? error.message : String(error)}`
      )
    }
    this.calls.push({ ...call, input })
    if (kind === 'done') {
      const { completion, message } = input as NativeDoneInput
      if (
        !isUndefined(completion) &&
        (!completion.trim() || completion.trim().length > GoalLimits.reasonChars)
      )
        throw protocolFailure(`完成依据需要 1 到 ${GoalLimits.reasonChars} 个字符`)
      this.done = true
      this.completion = completion?.trim()
      if (message) {
        const text = `${this.text && !this.text.endsWith('\n') ? '\n' : ''}${message}`
        this.text += text
        return [{ type: 'text', text }]
      }
      return []
    }
    const index = this.records.length
    let record: ScriptProtocolRecord
    if (kind === 'blobs') {
      const { name, text } = input as NativeBlobInput
      record = { kind, args: [name], body: text }
    } else {
      const { code, options = {} } = input as NativeExecutionInput | NativeObservationInput
      if (JSON.stringify(options).length > this.config.maxHeaderChars)
        throw protocolFailure('JSON 程序选项超过协议字符预算')
      record = { kind, args: [options], body: code }
    }
    this.records.push(record)
    return [
      { type: 'program', index, kind, phase: 'start', text: '' },
      { type: 'program', index, kind, phase: 'delta', text: record.body },
      { type: 'program', index, kind, phase: 'end', text: '' },
    ]
  }

  public finish(): ActDecodedTurn {
    this.consume(0)
    this.ended = true
    const submission = compileScriptRecords(
      this.records,
      this.config,
      this.inputs,
      NativeExecutionSchema
    )
    if (
      this.canFinishText() &&
      !this.done &&
      (!this.text.trim() || !isEmpty(this.calls)) &&
      isUndefined(submission.observe) &&
      isEmpty(submission.executions)
    )
      throw protocolFailure(
        `响应为空或仅包含未绑定原文：请给出普通文本答复，或按需调用 ${this.config.allowed
          .filter((kind) => kind !== 'blobs')
          .map((kind) => nativeToolName(kind, this.config))
          .join(' / ')}。${
          this.records.some((record) => record.kind === 'blobs')
            ? '本响应的原文尚未接纳。请把原文放进程序调用的 options.blobs，并在 code 中通过 import {blobs} from "velaros:program" 读取；或在同一响应同时提交原文与使用它的程序。'
            : ''
        }`
      )
    return {
      message: this.text,
      // 无工具的普通答复也走既有完成校验；等待中的工作和活动目标不会因此绕过验收。
      done:
        this.done ||
        (isEmpty(this.calls) &&
          Boolean(this.text.trim()) &&
          this.canFinishText() &&
          this.config.allowed.includes('done')),
      completion: this.completion,
      // 每个原生调用都需要持久配对回执，包括只含 blobs/done 的响应。
      submission: optionalWhen(!isEmpty(this.calls), submission),
      events: [],
    }
  }

  private consume(chars: number): void {
    if (this.ended) throw protocolFailure('完整响应只能接收一次')
    this.chars += chars
    if (this.chars > this.config.maxChars) throw protocolFailure('响应超过协议字符预算')
  }
}

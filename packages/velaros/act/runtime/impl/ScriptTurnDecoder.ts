import type { ActDecodedTurn, ActPreview } from '@velaros-ai/agent'
import { isEmpty, isString, isUndefined } from '@velaros-ai/core'
import { AppError } from '@velaros-ai/core/error'

import { GoalLimits } from '../../system/contract/constants.js'
import type { ScriptProtocolRecord, ScriptProtocolSubmission } from '../types/program.js'
import type { ScriptProtocolOptions } from '../types/runtime.js'
import { scriptInputCopy } from '../utils/program-context.js'
import {
  parseDeclaration,
  protocolConfig,
  protocolDecisionInstructions,
  protocolFailure,
  protocolInstructions,
} from '../utils/script-protocol.js'
import { compileScriptRecords } from '../utils/script-records.js'

/** 文本协议使用主循环规定的接收契约。 */
export interface ScriptTurnDecoderApi {
  /** 本帧控制身份与示例；固定语法由 Runtime 放入系统指令。 */
  readonly instructions: string
  /** 重置解析状态，保留标记和输入快照。 */
  reset(): void
  /** 接收文本增量，返回仅用于展示的预览。 */
  push(text: string): readonly ActPreview[]
  /** 完整校验后生成控制意图。 */
  finish(): ActDecodedTurn
}

/** 在同一文本流中分离 Markdown 与显式闭合的原文和程序。 */
export class ScriptTurnDecoder implements ScriptTurnDecoderApi {
  public readonly instructions: string
  private readonly config
  private readonly inputs: Readonly<Record<string, unknown>>
  private lineStart = true
  private candidate = ''
  private line = 1
  private chars = 0
  private idleWhitespaceChars = 0
  private message = ''
  private done = false
  /** done 声明附带的完成依据。 */
  private completion?: string
  private ended = false
  private records: ScriptProtocolRecord[] = []
  private active?: ScriptProtocolRecord
  private tail = ''
  private events: ActPreview[] = []

  public constructor(
    private readonly marker: string,
    options: ScriptProtocolOptions = {},
    inputs: Readonly<Record<string, unknown>> = {},
    private readonly requireDecision: () => boolean = () => false
  ) {
    this.config = protocolConfig(options)
    if (
      !marker.startsWith(this.config.markerPrefix) ||
      !/^[\w@]+$/u.test(marker) ||
      marker.length > 96
    )
      throw protocolFailure('帧标记无效')
    this.inputs = scriptInputCopy(inputs)
    this.instructions = protocolInstructions(marker, options, this.inputs)
  }

  public reset(): void {
    this.lineStart = true
    this.candidate = ''
    this.line = 1
    this.chars = 0
    this.idleWhitespaceChars = 0
    this.message = ''
    this.done = false
    this.completion = undefined
    this.ended = false
    this.records = []
    this.active = undefined
    this.tail = ''
    this.events = []
  }

  public push(text: string): readonly ActPreview[] {
    if (this.ended) throw protocolFailure('完整响应之后不能追加内容')
    this.events = []
    this.chars += text.length
    if (this.chars > this.config.maxChars) throw protocolFailure('响应超过协议字符预算')
    for (let index = 0; index < text.length; index++) {
      const char = text[index]
      if (this.lineStart) {
        this.candidate += char
        const prefix = this.candidate
        if (this.marker.startsWith(prefix)) continue
        if (
          prefix.startsWith(this.marker) &&
          [' ', '\r', '\n'].includes(prefix[this.marker.length])
        ) {
          if (prefix.length > this.config.maxHeaderChars)
            throw protocolFailure('控制头超过预算', this.line)
          if (char === '\n') {
            this.header(prefix.slice(0, -1).replace(/\r$/u, ''))
            this.candidate = ''
            this.line++
          }
          continue
        }
        this.route(prefix)
        this.candidate = ''
        this.lineStart = char === '\n'
      } else {
        this.route(char)
        if (char === '\n') this.lineStart = true
      }
      if (char === '\n') this.line++
    }
    return this.events
  }

  public finish(): ActDecodedTurn {
    if (this.ended) throw protocolFailure('完整响应只能接收一次')
    this.events = []
    if (this.candidate) {
      if (this.candidate === this.marker || this.candidate.startsWith(`${this.marker} `))
        this.header(this.candidate.replace(/\r$/u, ''))
      else this.route(this.candidate)
    }
    if (this.active)
      throw protocolFailure(
        `控制段缺少闭合标记。闭合行必须逐字为：\n${this.marker}\n请核对标记后重新输出完整响应；不能只补闭合行。`,
        this.active.line
      )
    this.ended = true
    const { observe, executions } = compileScriptRecords(this.records, this.config, this.inputs)
    if (this.requireDecision() && !this.done && isUndefined(observe) && isEmpty(executions))
      throw protocolFailure(protocolDecisionInstructions(this.marker, this.config))
    const submission: ScriptProtocolSubmission = { observe, executions }
    const result = { message: this.message, done: this.done, events: this.events }
    if (!isUndefined(this.completion)) Object.assign(result, { completion: this.completion })
    if (!isUndefined(observe) || !isEmpty(executions)) Object.assign(result, { submission })
    return result
  }

  private header(line: string): void {
    this.idleWhitespaceChars = 0
    if (line.replace(/ +$/u, '') === this.marker) {
      if (!this.active) throw protocolFailure('闭合标记没有对应的控制段', this.line)
      this.emit({
        type: 'program',
        index: this.records.length,
        kind: this.active.kind,
        phase: 'end',
        text: '',
      })
      this.records.push(this.active)
      this.active = undefined
      this.tail = ''
      return
    }
    if (this.active)
      throw protocolFailure(
        `上一 ${this.config.names[this.active.kind]} 控制段尚未闭合，不能嵌套。闭合行必须逐字为：\n${this.marker}\n下一控制头不能代替闭合行。请先闭合原段，再另起下一控制头，并重新输出完整响应；不能只补闭合行。`,
        this.line
      )
    if (this.done) throw protocolFailure('完成声明之后不能再声明控制操作', this.line)
    let declaration
    try {
      declaration = parseDeclaration(line.slice(this.marker.length + 1))
    } catch (error) {
      throw protocolFailure(error instanceof Error ? error.message : String(error), this.line)
    }
    const kind = (Object.keys(this.config.names) as Array<keyof typeof this.config.names>).find(
      (key) => this.config.names[key] === declaration.name
    )
    if (kind && !this.config.allowed.includes(kind))
      throw protocolFailure(`当前运行模式禁止 ${kind}`, this.line)
    if (!kind) throw protocolFailure(`未知控制声明：${declaration.name}`, this.line)
    if (kind === 'done') {
      const [claim, ...rest] = declaration.args
      if (!isEmpty(rest) || (!isUndefined(claim) && (!isString(claim) || !claim.trim())))
        throw protocolFailure('done 至多带一个非空的完成依据字符串', this.line)
      if (isString(claim) && claim.trim().length > GoalLimits.reasonChars)
        throw protocolFailure(`完成依据最多 ${GoalLimits.reasonChars} 个字符`, this.line)
      this.done = true
      if (isString(claim)) this.completion = claim.trim()
      return
    }
    if (this.records.length >= this.config.maxBlocks)
      throw protocolFailure('控制段数量超过预算', this.line)
    this.active = { kind, args: declaration.args, body: '', line: this.line }
    this.tail = ''
    this.emit({ type: 'program', index: this.records.length, kind, phase: 'start', text: '' })
  }

  private route(text: string): void {
    if (!this.active) {
      // 仅检查真实闭合段后的协议外空白，源码、blobs 及控制头按各自预算完整接收。
      // 使用终止错误而非可修复语法错误：取消后上游用量可能尚未结算，不能自动重发。
      if (this.done || !isEmpty(this.records))
        for (const char of text) {
          this.idleWhitespaceChars = /\s/u.test(char) ? this.idleWhitespaceChars + 1 : 0
          if (this.idleWhitespaceChars > this.config.maxIdleWhitespaceChars)
            throw AppError.withFields(
              'PROTOCOL',
              '模型在闭合控制段后持续输出空白，响应已停止，程序没有执行',
              {
                condition: 'scriptact-idle-whitespace',
                limit: this.config.maxIdleWhitespaceChars,
              }
            )
        }
      // 控制段后的散文没有公开回复身份；原文仍由主循环完整审计，合法程序照常受理。
      // 只展示首个控制前的进度和 done 后的答复，不按内容猜测或再花一轮修复。
      if (!this.done && !isEmpty(this.records)) return
      this.message += text
      this.emit({ type: 'text', text })
      return
    }
    for (let index = 0; index < text.length; index++) {
      const char = text[index]
      if (char === '\n' && this.tail === '\r') {
        this.tail = '\r\n'
        continue
      }
      if (this.tail) {
        this.active.body += this.tail
        this.emit({
          type: 'program',
          index: this.records.length,
          kind: this.active.kind,
          phase: 'delta',
          text: this.tail,
        })
        this.tail = ''
      }
      if (char === '\r' || char === '\n') this.tail = char
      else {
        this.active.body += char
        this.emit({
          type: 'program',
          index: this.records.length,
          kind: this.active.kind,
          phase: 'delta',
          text: char,
        })
      }
    }
  }

  private emit(event: ActPreview): void {
    const previous = this.events.at(-1)
    if (previous?.type === 'text' && event.type === 'text')
      this.events[this.events.length - 1] = { type: 'text', text: previous.text + event.text }
    else if (
      previous?.type === 'program' &&
      event.type === 'program' &&
      previous.phase === 'delta' &&
      event.phase === 'delta' &&
      previous.index === event.index
    )
      this.events[this.events.length - 1] = { ...event, text: previous.text + event.text }
    else this.events.push(event)
  }
}

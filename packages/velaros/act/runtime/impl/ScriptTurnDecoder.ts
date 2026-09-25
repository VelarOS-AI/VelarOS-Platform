import type { ActDecodedTurn, ActPreview } from '@velaros-ai/agent'
import { isTrue, isUndefined } from '@velaros-ai/core'
import { isBoolean, isEmpty, isObject, isPlainObject, isString } from '@velaros-ai/core'

import { GoalLimits } from '../../system/contract/constants.js'
import type { ScriptProtocolSubmission } from '../types/program.js'
import type { ScriptProtocolOptions } from '../types/runtime.js'
import type { ScriptSubmission } from '../types/session.js'
import { scriptInputCopy } from '../utils/program-context.js'
import {
  parseDeclaration,
  protocolConfig,
  protocolFailure,
  protocolInstructions,
} from '../utils/script-protocol.js'

import { standardModules } from './StandardModules.js'

/** 文本协议使用主循环规定的接收契约。 */
export interface ScriptTurnDecoderApi {
  /** 本帧固定的协议说明。 */
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
  private message = ''
  private done = false
  /** done 声明附带的完成依据。 */
  private completion?: string
  private ended = false
  private records: Array<{
    kind: 'blobs' | 'observe' | 'execute'
    args: readonly unknown[]
    body: string
    line: number
  }> = []
  private active?: {
    kind: 'blobs' | 'observe' | 'execute'
    args: readonly unknown[]
    body: string
    line: number
  }
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
    if (this.active) throw protocolFailure('控制段缺少闭合标记', this.active.line)
    this.ended = true
    const blobs: Record<string, string> = Object.create(null)
    for (const record of this.records.filter((record) => record.kind === 'blobs')) {
      const name = record.args[0]
      if (record.args.length !== 1 || !isString(name) || !name || name.length > 256)
        throw protocolFailure('blobs 必须提供一个非空名称', record.line)
      if (Object.hasOwn(blobs, name)) throw protocolFailure(`原文名称重复：${name}`, record.line)
      blobs[name] = record.body
    }
    let observe: ScriptProtocolSubmission['observe']
    const executions: Array<ScriptProtocolSubmission['executions'][number]> = []
    for (const record of this.records.filter((record) => record.kind !== 'blobs')) {
      if (record.args.length > 1) throw protocolFailure('程序声明最多接受一个选项对象', record.line)
      const options = !isEmpty(record.args) ? record.args[0] : {}
      if (!isPlainObject(options)) throw protocolFailure('程序选项必须是对象', record.line)
      const {
        async: background = false,
        retain,
        inputRef,
        clear,
        format,
        ...fields
      } = options as Record<string, unknown>
      if (record.kind === 'observe' && !isUndefined(observe))
        throw protocolFailure('一份响应最多更新一次观察', record.line)
      if (
        (record.kind === 'observe' &&
          (Object.hasOwn(options, 'async') || Object.hasOwn(options, 'retain'))) ||
        !isBoolean(background)
      )
        throw protocolFailure('调度选项无效', record.line)
      if (!isUndefined(clear)) {
        if (
          !isTrue(clear) ||
          record.kind !== 'observe' ||
          Object.keys(options).length !== 1 ||
          !isEmpty(record.body)
        )
          throw protocolFailure('清除观察使用 observe({clear:true}) 和空段', record.line)
        observe = null
        continue
      }
      if (!isUndefined(inputRef)) {
        if (
          'input' in fields ||
          !isString(inputRef) ||
          !inputRef.startsWith('host:') ||
          !Object.hasOwn(this.inputs, inputRef.slice(5))
        )
          throw protocolFailure('宿主参数引用无效或与 input 冲突', record.line)
        fields.input = this.inputs[inputRef.slice(5)]
      }
      let program: Record<string, unknown>
      if (format === 'program') {
        if (!isEmpty(Object.keys(fields)))
          throw protocolFailure('完整程序载荷不能同时使用程序头字段', record.line)
        try {
          program = JSON.parse(record.body)
        } catch {
          throw protocolFailure('完整程序载荷必须是 JSON 对象', record.line)
        }
        if (!isPlainObject(program)) throw protocolFailure('完整程序载荷必须是对象', record.line)
      } else {
        if (!isUndefined(format)) throw protocolFailure('程序载荷格式无效', record.line)
        if ('source' in fields || 'retainTurns' in fields)
          throw protocolFailure('源码放在段内，租期使用 retain', record.line)
        const reference = 'sourceRef' in fields || 'edits' in fields
        if (reference && !isEmpty(record.body))
          throw protocolFailure('引用或编辑模式必须使用空段', record.line)
        program = { ...fields }
        if (!reference) program.source = record.body
      }
      if (!isEmpty(Object.keys(blobs))) {
        if (
          program.blobs &&
          isObject(program.blobs) &&
          Object.keys(program.blobs).some((name) => Object.hasOwn(blobs, name))
        )
          throw protocolFailure('原文绑定与程序内 blobs 重名', record.line)
        if (program.blobs && !isPlainObject(program.blobs))
          throw protocolFailure('blobs 必须是对象', record.line)
        program.blobs = { ...(program.blobs as Optional<Record<string, string>>), ...blobs }
      }
      let parsed: ScriptSubmission
      if (record.kind === 'execute' && (!isUndefined(retain) || this.config.defaultRetain !== 2))
        program.retainTurns = retain ?? program.retainTurns ?? this.config.defaultRetain
      try {
        parsed = standardModules.parseScript({ [record.kind]: program })
      } catch (error) {
        throw protocolFailure(error instanceof Error ? error.message : String(error), record.line)
      }
      if (record.kind === 'observe') observe = parsed.observe
      else executions.push({ program: parsed.execute!, async: background })
    }
    if (this.requireDecision() && !this.done && isUndefined(observe) && isEmpty(executions))
      throw protocolFailure(
        `缺少本轮控制决策：请按当前合同提交 ${this.config.allowed
          .filter((kind) => kind !== 'blobs')
          .map((kind) => this.config.names[kind])
          .join(' / ')} 声明；需要用户回答请通过当前交互工具请求。纯说明文字不会执行工作。`
      )
    const submission: ScriptProtocolSubmission = { observe, executions }
    const result = { message: this.message, done: this.done, events: this.events }
    if (!isUndefined(this.completion)) Object.assign(result, { completion: this.completion })
    if (!isUndefined(observe) || !isEmpty(executions)) Object.assign(result, { submission })
    return result
  }

  private header(line: string): void {
    if (line === this.marker) {
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
    if (this.active) throw protocolFailure('请先闭合上一控制段，不能嵌套', this.line)
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

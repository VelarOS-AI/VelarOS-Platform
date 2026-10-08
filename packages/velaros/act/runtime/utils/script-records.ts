import {
  isBoolean,
  isEmpty,
  isObject,
  isPlainObject,
  isString,
  isTrue,
  isUndefined,
} from '@velaros-ai/core'

import type { ScriptProtocolRecord, ScriptProtocolSubmission } from '../types/program.js'
import type { ScriptSubmission } from '../types/session.js'

import { scriptInputCopy } from './program-context.js'
import { type protocolConfig, protocolFailure } from './script-protocol.js'
import { checkScriptSubmission } from './script-submission.js'

/** 两种传输共用声明绑定与预检，完整响应通过后才交给运行时。 */
export function compileScriptRecords(
  records: readonly ScriptProtocolRecord[],
  config: ReturnType<typeof protocolConfig>,
  inputs: Readonly<Record<string, unknown>>
): ScriptProtocolSubmission {
  const blobs: Record<string, string> = Object.create(null)
  for (const record of records.filter((record) => record.kind === 'blobs')) {
    const name = record.args[0]
    if (record.args.length !== 1 || !isString(name) || !name || name.length > 256)
      throw protocolFailure('blobs 必须提供一个非空名称', record.line)
    if (Object.hasOwn(blobs, name)) throw protocolFailure(`原文名称重复：${name}`, record.line)
    blobs[name] = record.body
  }
  let observe: ScriptProtocolSubmission['observe']
  const executions: Array<ScriptProtocolSubmission['executions'][number]> = []
  for (const record of records.filter((record) => record.kind !== 'blobs')) {
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
      throw protocolFailure(
        '调度选项无效：async 必须是布尔值；observe 不接受 async 或 retain，请去掉这些执行专用字段',
        record.line
      )
    if (!isUndefined(clear)) {
      if (
        !isTrue(clear) ||
        record.kind !== 'observe' ||
        Object.keys(options).length !== 1 ||
        !isEmpty(record.body)
      )
        throw protocolFailure('清除观察必须仅提供 clear:true 选项并使用空源码', record.line)
      observe = null
      continue
    }
    if (!isUndefined(inputRef)) {
      if (
        'input' in fields ||
        !isString(inputRef) ||
        !inputRef.startsWith('host:') ||
        !Object.hasOwn(inputs, inputRef.slice(5))
      )
        throw protocolFailure('宿主参数引用无效或与 input 冲突', record.line)
      fields.input = inputs[inputRef.slice(5)]
    }
    let program: Record<string, unknown>
    if (format === 'program') {
      if (!isEmpty(Object.keys(fields)))
        throw protocolFailure('完整程序载荷与外层程序字段互斥', record.line)
      try {
        program = JSON.parse(record.body)
      } catch {
        throw protocolFailure('完整程序载荷必须是 JSON 对象', record.line)
      }
      if (!isPlainObject(program)) throw protocolFailure('完整程序载荷必须是对象', record.line)
    } else {
      if (!isUndefined(format)) throw protocolFailure('程序载荷格式无效', record.line)
      if ('source' in fields || 'retainTurns' in fields)
        throw protocolFailure(
          '程序选项不接受 source 或 retainTurns，结果保留使用 retain',
          record.line
        )
      const reference = 'sourceRef' in fields || 'edits' in fields || 'snapshot' in fields
      if (reference && !isEmpty(record.body))
        throw protocolFailure('引用或编辑模式必须使用空源码', record.line)
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
    if (record.kind === 'execute')
      program.retainTurns = retain ?? program.retainTurns ?? config.defaultRetain
    try {
      const candidate = scriptInputCopy({ [record.kind]: program })
      checkScriptSubmission(candidate)
      parsed = candidate
    } catch (error) {
      throw protocolFailure(error instanceof Error ? error.message : String(error), record.line)
    }
    if (record.kind === 'observe') observe = parsed.observe
    else executions.push({ program: parsed.execute!, async: background })
  }
  return { observe, executions }
}

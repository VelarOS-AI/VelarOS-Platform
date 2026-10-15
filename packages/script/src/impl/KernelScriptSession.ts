import { isUndefined } from '@velaros-ai/core'
import { isArray, isString } from '@velaros-ai/core'
import { AppError } from '@velaros-ai/core/error'
import type { ModuleBinding } from '@velaros-ai/kernel'

import { CodeProgramEditLimits, CodeSurfaceErrorCodes } from '../contract/constants.js'
import type { KernelScriptSessionOptions } from '../contract/requires.js'
import type { CodeSurfaceOutcome } from '../types/outcome.js'
import type {
  CodeProgramCheckResult,
  CodeProgramEditResult,
  CodeProgramRequest,
  CodeProgramTargetEdit,
} from '../types/script.js'
import { applyProgramEdits } from '../utils/edit.js'
import { readModuleSpecifiers, readProgramModuleSpecifiers } from '../utils/module-form.js'
import { describeProgramOversize } from '../utils/result.js'

import { codeProgramChecker } from './CodeProgramChecker.js'
import { createCodeSurfaceSession } from './CodeSurfaceSession.js'
import { KernelInvocationPort } from './KernelInvocationPort.js'
import { nodeProgramChecker } from './NodeProgramChecker.js'
import { scriptPackageCompiler } from './ScriptPackageCompiler.js'

/** 在同一个 Kernel 上检查并运行脚本的入口。 */
export interface KernelScriptSessionApi {
  /** 按同一底稿精确应用整组编辑，不检查或执行代码。 */
  edit(program: CodeProgramRequest, edits: readonly CodeProgramTargetEdit[]): CodeProgramEditResult
  /** 只检查源码与当前能力声明，不执行任何代码。 */
  check(program: CodeProgramRequest): CodeProgramCheckResult
  /** 按同一静态 import 与包展开规则读取当前授权挂载，不运行程序。 */
  dependencies(program: CodeProgramRequest): readonly ModuleBinding[]
  /** 源码与输出有界；初次 import 即取得当前挂载的准确声明。 */
  run(program: CodeProgramRequest, signal?: AbortSignal): Promise<CodeSurfaceOutcome>
}

class KernelScriptSession implements KernelScriptSessionApi {
  private used = false

  public constructor(private readonly options: KernelScriptSessionOptions) {}

  public edit(
    program: CodeProgramRequest,
    edits: readonly CodeProgramTargetEdit[]
  ): CodeProgramEditResult {
    if (!isArray(edits) || edits.length < 1 || edits.length > CodeProgramEditLimits.edits)
      return {
        ok: false,
        code: 'SCRIPT_EDIT',
        message: `edits 必须包含 1 到 ${CodeProgramEditLimits.edits} 项`,
      }
    const groups = new Map<
      Optional<string>,
      Array<{ index: number; edit: CodeProgramTargetEdit }>
    >()
    for (const [index, edit] of edits.entries()) {
      if (
        !edit ||
        !isString(edit.oldText) ||
        !isString(edit.newText) ||
        (!isUndefined(edit.module) && !isString(edit.module))
      )
        return {
          ok: false,
          code: 'SCRIPT_EDIT',
          editIndex: index,
          message: '编辑项必须提供 oldText/newText 字符串与可选 module',
        }
      if (!isUndefined(edit.module) && !Object.hasOwn(program.modules ?? {}, edit.module))
        return {
          ok: false,
          code: 'SCRIPT_EDIT',
          editIndex: index,
          message: `附属模块不存在：${edit.module}`,
        }
      groups.set(edit.module, [...(groups.get(edit.module) ?? []), { index, edit }])
    }
    let source = program.source
    const modules = { ...program.modules }
    for (const [target, items] of groups) {
      const result = applyProgramEdits(
        isUndefined(target) ? program.source : program.modules![target]!,
        items.map((item) => item.edit)
      )
      if ('failed' in result)
        return {
          ok: false,
          code: 'SCRIPT_EDIT',
          editIndex: items[result.editIndex]!.index,
          message: result.failed,
        }
      if (isUndefined(target)) source = result.source
      else
        Object.defineProperty(modules, target, {
          value: result.source,
          enumerable: true,
          writable: true,
          configurable: true,
        })
    }
    return {
      ok: true,
      program: { ...program, source, modules: program.modules ? modules : undefined },
      changed:
        source !== program.source ||
        Object.entries(modules).some(([key, value]) => value !== program.modules?.[key]),
    }
  }

  public check(program: CodeProgramRequest): CodeProgramCheckResult {
    const oversized = describeProgramOversize(program.source, program.blobs, program.input)
    if (oversized) throw new AppError(CodeSurfaceErrorCodes.tooLarge, oversized)
    if (this.options.runner.environment === 'node')
      return nodeProgramChecker.check({ ...program, granted: [] })
    const imported = new Set(
      [program.source, ...Object.values(program.modules ?? {})].flatMap(readModuleSpecifiers)
    )
    for (const pkg of this.options.packages ?? [])
      if (imported.has(pkg.specifier))
        for (const target of Object.values(pkg.exports)) imported.add(target)
    const port = new KernelInvocationPort(this.options, imported)
    const surface = scriptPackageCompiler.compile(
      this.options.packages ?? [],
      Object.keys(port.listOperations()).map((namespace) => ({
        namespace,
        declarations: this.options.runtime.describe(namespace).declarations,
      }))
    )
    return codeProgramChecker.check({ ...program, granted: surface.granted })
  }

  public dependencies(program: CodeProgramRequest): readonly ModuleBinding[] {
    const imported = new Set(readProgramModuleSpecifiers(program))
    for (const pkg of this.options.packages ?? [])
      if (imported.has(pkg.specifier))
        for (const target of Object.values(pkg.exports)) imported.add(target)
    return new KernelInvocationPort(this.options, imported).dependencies()
  }

  public run(program: CodeProgramRequest, signal?: AbortSignal): Promise<CodeSurfaceOutcome> {
    if (this.used)
      return Promise.reject(
        new AppError('CONFLICT', '同一脚本执行身份不能再次运行；继续工作请创建新的执行')
      )
    this.used = true
    const imported = new Set(
      [program.source, ...Object.values(program.modules ?? {})].flatMap(readModuleSpecifiers)
    )
    for (const pkg of this.options.packages ?? [])
      if (imported.has(pkg.specifier))
        for (const target of Object.values(pkg.exports)) imported.add(target)
    const port = new KernelInvocationPort(this.options, imported)
    if (this.options.runner.environment === 'node') {
      const modules = Object.fromEntries(
        Object.keys(port.listOperations()).map((namespace) => {
          const description = this.options.runtime.describe(namespace)
          return [
            namespace,
            { summary: description.summary, declarations: description.declarations },
          ]
        })
      )
      return createCodeSurfaceSession({
        checker: nodeProgramChecker,
        runner: this.options.runner,
        capabilities: port,
        events: this.options.events,
      }).submit({
        program,
        signal,
        granted: [],
        packages: this.options.packages,
        mode: this.options.mode,
        timeoutMs: this.options.timeoutMs,
        host: { sessionId: this.options.sessionId, executionId: this.options.executionId, modules },
      })
    }
    const surface = scriptPackageCompiler.compile(
      this.options.packages ?? [],
      Object.keys(port.listOperations()).map((namespace) => ({
        namespace,
        declarations: this.options.runtime.describe(namespace).declarations,
      }))
    )
    const session = createCodeSurfaceSession({
      checker: codeProgramChecker,
      runner: this.options.runner,
      capabilities: port,
      events: this.options.events,
    })
    return session.submit({
      program,
      signal,
      granted: surface.granted,
      packages: surface.packages,
      timeoutMs: this.options.timeoutMs,
    })
  }
}

/** 组装脚本检查和隔离桥，不创建第二份模块注册表或调用日志。 */
export function createKernelScriptSession(
  options: KernelScriptSessionOptions
): KernelScriptSessionApi {
  return new KernelScriptSession(options)
}

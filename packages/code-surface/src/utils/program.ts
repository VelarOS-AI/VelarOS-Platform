/**
 * 程序正文的约定与编码。
 *
 * **程序是一个 ES 模块**：`import` 拿能力，顶层 `await` 直接用，`export default` 交出答案。
 * 早先用「函数体 + `return`」是为了支持顶层 await，但模块原生就支持它，那个理由没了；
 * 而「import 在上面、然后 return」**不是合法 JS**，等于让模型写一种方言——
 * 这恰恰违背「模型写它熟悉的东西」这条依仗，而那是代码面唯一的依仗。
 */

import { CodeSurfaceLimits } from '../contract/constants.js'

/** 内存里那份程序的文件名；诊断按它过滤。后缀是 `.js`——模型写的就是 JavaScript，靠 `checkJs` 查。 */
export const ProgramFileName = '/program.js'

/** 这次运行本身的环境模块：`import { blobs } from 'velar:program'`。恒常授权，不占名额。 */
export const ProgramModuleSpecifier = 'velar:program'

/** 能力模块的统一前缀：`import { read } from 'velar:system'`。 */
export const CapabilityModulePrefix = 'velar:'

/** 从模块名取命名空间：`velar:system` → `system`。不是能力模块就返回 null。 */
export function readCapabilityNamespace(moduleSpecifier: string): Nullable<string> {
  return moduleSpecifier.startsWith(CapabilityModulePrefix)
    ? moduleSpecifier.slice(CapabilityModulePrefix.length)
    : null
}

/**
 * 检查时用的程序正文。
 *
 * 模块本来就能直接检查，不用包装——**这一点很重要**：不包装就没有行号偏移，
 * 诊断报的行号就是模型写的那一行，不需要任何换算。
 */
export function programForCheck(source: string): string {
  return source
}

/** 体量超限的说明；超限一律拒，不截断后照跑——半截程序跑出来的结果比不跑更坏。 */
export function describeOversized(what: 'source' | 'blobs', actual: number): string {
  const limit = what === 'source' ? CodeSurfaceLimits.sourceChars : CodeSurfaceLimits.blobChars
  const name = what === 'source' ? '程序正文' : 'blobs 合计'
  return `${name} ${actual} 字符，超过上限 ${limit}。把它拆成几次，或者把大块内容留在能力那一侧处理（比如让 project:search 先筛一遍），不要整段搬进来。`
}

/**
 * 按预算保留结尾。
 *
 * 保留结尾而不是开头，与 `system:run` 的输出窗口同一个口径：失败现场在尾部。
 * 截掉时在头上留一句说明，模型才知道自己看到的是一段而不是全部。
 */
export function keepTail(text: string, budgetChars: number): { text: string; dropped: number } {
  if (text.length <= budgetChars) return { text, dropped: 0 }
  const dropped = text.length - budgetChars
  return { text: `…前面 ${dropped} 字符省略…\n${text.slice(dropped)}`, dropped }
}

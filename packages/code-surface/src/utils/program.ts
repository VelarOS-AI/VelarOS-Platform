/** 程序正文的包装与编码：typecheck 与隔离运行两侧共用同一份，包装方式不一致会让行号对不上。 */

import { CodeSurfaceLimits } from '../contract/constants.js'

/** 内存里那份程序的文件名；诊断按它过滤。后缀是 `.js`——模型写的就是 JavaScript，靠 `checkJs` 查。 */
export const ProgramFileName = '/program.js'

/**
 * 把模型写的函数体包成一个可检查、可执行的整体。
 *
 * `{` 后面必须紧跟换行：这样模型写的第 1 行正好落在文件第 1 行（0 基），报出去的行号与它写的对得上。
 * 少这个换行，首行的诊断就会偏一位——模型照着改会改错地方。
 */
export function wrapProgramSource(source: string): string {
  return `export default (async () => {\n${source}\n})`
}

/** 程序里能引用的形参名：能力命名空间之外，固定给这两个。 */
export const ProgramReservedParameters = Object.freeze(['blobs', 'console'] as const)

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

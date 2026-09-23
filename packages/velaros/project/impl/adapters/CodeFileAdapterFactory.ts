/**
 * 通用代码 adapter 的工厂：`CodeFileAdapterFactory`，实现注入面的 `FileAdapterFactory`（contract/requires.ts）。
 * 面向存在、不是二进制的非 JS/TS 源文件。
 */

import type { FileAdapter, FileAdapterFactory } from '../../contract/requires.js'
import type { FileSnapshot } from '../../types/snapshot.js'
import { ext } from '../../utils/path.js'

import { CodeFileAdapter } from './CodeFileAdapter.js'

export class CodeFileAdapterFactory implements FileAdapterFactory {
  /**
   * 按通用代码处理的扩展名。JS/TS 由 JS/TS adapter 的 AST 符号独占：正则加括号计数的范围一旦参与 JS/TS 的解析，
   * 就会以低优先级候选的身份把错误范围混进 resolveTarget 与 listSymbols。
   */
  private static readonly Extensions: ReadonlySet<string> = new Set([
    '.py',
    '.go',
    '.rs',
    '.java',
    '.c',
    '.cpp',
    '.h',
    '.hpp',
    '.cs',
    '.php',
    '.rb',
    '.swift',
    '.kt',
  ])

  public readonly id = 'core.code.factory'

  public canHandle(snapshot: FileSnapshot): boolean {
    return (
      snapshot.exists &&
      !snapshot.isBinary &&
      CodeFileAdapterFactory.Extensions.has(ext(snapshot.path))
    )
  }

  public create(): FileAdapter {
    return new CodeFileAdapter()
  }
}

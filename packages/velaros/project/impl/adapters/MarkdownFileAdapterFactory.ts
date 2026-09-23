/**
 * Markdown adapter 的工厂：`MarkdownFileAdapterFactory`，实现注入面的 `FileAdapterFactory`（contract/requires.ts）。
 * 面向存在、不是二进制的 .md、.markdown、.mdx 文件。
 */

import type { FileAdapter, FileAdapterFactory } from '../../contract/requires.js'
import type { FileSnapshot } from '../../types/snapshot.js'
import { ext } from '../../utils/path.js'

import { MarkdownFileAdapter } from './MarkdownFileAdapter.js'

export class MarkdownFileAdapterFactory implements FileAdapterFactory {
  /** 按 Markdown 处理的扩展名。 */
  private static readonly Extensions: ReadonlySet<string> = new Set(['.md', '.markdown', '.mdx'])

  public readonly id = 'core.markdown.factory'

  public canHandle(snapshot: FileSnapshot): boolean {
    return (
      snapshot.exists &&
      !snapshot.isBinary &&
      MarkdownFileAdapterFactory.Extensions.has(ext(snapshot.path))
    )
  }

  public create(): FileAdapter {
    return new MarkdownFileAdapter()
  }
}

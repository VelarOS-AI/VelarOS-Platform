/**
 * 纯文本 adapter 的工厂：`TextFileAdapterFactory`，实现注入面的 `FileAdapterFactory`（contract/requires.ts）。
 * 面向所有存在、不是目录、不是二进制的文件；更强的 adapter 以更高 priority 覆盖它。
 */

import type { FileAdapter, FileAdapterFactory } from '../../contract/requires.js'
import type { FileSnapshot } from '../../types/snapshot.js'

import { TextFileAdapter } from './TextFileAdapter.js'

export class TextFileAdapterFactory implements FileAdapterFactory {
  public readonly id = 'core.text.factory'

  public canHandle(snapshot: FileSnapshot): boolean {
    return snapshot.exists && !snapshot.isDirectory && !snapshot.isBinary
  }

  public create(): FileAdapter {
    return new TextFileAdapter()
  }
}

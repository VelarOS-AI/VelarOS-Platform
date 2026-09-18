/**
 * JS/TS adapter 的工厂：`JsTsFileAdapterFactory`，实现注入面的 `FileAdapterFactory`（contract/requires.ts）。
 * 面向存在、不是目录、不是二进制的 JS/TS 源文件；身份（工厂与 adapter 的 id、优先级、检查项名）由注册它的插件给。
 */

import type { FileAdapter, FileAdapterFactory } from '../../contract/requires.js'
import type { JsTsAdapterIdentity } from '../../types/jsts.js'
import type { FileSnapshot } from '../../types/snapshot.js'
import { isJsTsPath } from '../../utils/jsts-ast.js'

import { JsTsFileAdapter } from './JsTsFileAdapter.js'

export class JsTsFileAdapterFactory implements FileAdapterFactory {
  public readonly id: string

  public constructor(private readonly identity: JsTsAdapterIdentity) {
    this.id = identity.factoryId
  }

  public canHandle(snapshot: FileSnapshot): boolean {
    return snapshot.exists && !snapshot.isDirectory && !snapshot.isBinary && isJsTsPath(snapshot.path)
  }

  public create(): FileAdapter {
    return new JsTsFileAdapter(this.identity)
  }
}

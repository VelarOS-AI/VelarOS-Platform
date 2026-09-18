/**
 * JSON adapter 的工厂：`JsonFileAdapterFactory`，实现注入面的 `FileAdapterFactory`（contract/requires.ts）。
 * 面向存在、不是二进制的 .json 文件。
 */

import type { FileAdapter, FileAdapterFactory } from '../../contract/requires.js'
import type { FileSnapshot } from '../../types/snapshot.js'
import { ext } from '../../utils/path.js'

import { JsonFileAdapter } from './JsonFileAdapter.js'

export class JsonFileAdapterFactory implements FileAdapterFactory {
  public readonly id = 'core.json.factory'

  public canHandle(snapshot: FileSnapshot): boolean {
    return snapshot.exists && !snapshot.isBinary && ext(snapshot.path) === '.json'
  }

  public create(): FileAdapter {
    return new JsonFileAdapter()
  }
}

/**
 * 文件适配器登记表：`AdapterRegistry`。接口 `AdapterRegistryApi` 在本文件的类上方。
 */

import type { FileAdapter, FileAdapterFactory } from '../../contract/requires.js'
import type { FileSnapshot } from "../../types/snapshot.js";

/** 管理文件 adapter 工厂（插件经 registerAdapterFactory 登记），为一个快照按 priority 创建能处理它的 adapter。实例由内核持有，一个内核一份。 */
export interface AdapterRegistryApi {
  /** 登记一个文件 adapter 工厂；同一个工厂号只登记第一次。 */
  register(factory: FileAdapterFactory): void;
  /** 已登记的工厂号，按登记顺序。 */
  listFactoryIds(): string[];
  /** 为快照创建所有 canHandle 为真的工厂给出的 adapter，priority 高的排前面；kernel 原样交给工厂。工厂抛出的错误原样抛出。 */
  createAdapters(snapshot: FileSnapshot, kernel: any): Promise<FileAdapter[]>;
}

export class AdapterRegistry implements AdapterRegistryApi {
  private factories: FileAdapterFactory[] = [];
  private factoryIds = new Set<string>();

  public register(factory: FileAdapterFactory): void {
    if (this.factoryIds.has(factory.id)) return;
    this.factoryIds.add(factory.id);
    this.factories.push(factory);
  }

  public listFactoryIds(): string[] {
    return this.factories.map((f) => f.id);
  }

  public async createAdapters(snapshot: FileSnapshot, kernel: any): Promise<FileAdapter[]> {
    const adapters: FileAdapter[] = [];
    for (const factory of this.factories) {
      if (await factory.canHandle(snapshot)) {
        adapters.push(await factory.create({ snapshot, kernel }));
      }
    }
    // 高 priority adapter 先运行，确保 TS/LSP 等强语义 adapter 优先于纯文本回退。
    adapters.sort((a, b) => (b.priority ?? 0) - (a.priority ?? 0));
    return adapters;
  }
}

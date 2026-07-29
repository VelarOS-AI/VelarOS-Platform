import type { FileAdapter, FileAdapterFactory } from "../types/adapter.js";
import type { FileSnapshot } from "../types/snapshot.js";

/** 管理文件 adapter factory，并按 priority 创建适合某个 snapshot 的 adapter。 */
export class AdapterRegistry {
  private factories: FileAdapterFactory[] = [];
  private factoryIds = new Set<string>();

  /** 注册一个文件适配器工厂。 */
  public register(factory: FileAdapterFactory): void {
    if (this.factoryIds.has(factory.id)) return;
    this.factoryIds.add(factory.id);
    this.factories.push(factory);
  }

  /** 返回当前已注册的文件适配器工厂 id。 */
  public listFactoryIds(): string[] {
    return this.factories.map((f) => f.id);
  }

  /** 为指定 snapshot 创建可处理它的适配器，并按优先级排序。 */
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

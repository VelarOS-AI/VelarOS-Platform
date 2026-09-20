/**
 * 生命周期 hook 登记表：`HookRegistry`。接口 `HookRegistryApi` 在本文件的类上方。
 */

import type { ProjectHook } from '../../contract/requires.js'
import type { HookEvent } from "../../types/hook.js";

/** 管理生命周期 hook（插件经 registerHook 登记，宿主也可以直接登记），内核在读、搜索、准备、应用、校验、回滚前后触发。实例由内核持有，一个内核一份。 */
export interface HookRegistryApi {
  /** 登记一个 hook；同一事件的 hook 按登记顺序运行。 */
  register(hook: ProjectHook): void;
  /** 已登记的全部 hook（拷贝的数组）。 */
  list(): ProjectHook[];
  /** 依次运行订阅了这个事件的 hook，把 kernel 与 data 交给它们；某个 hook 抛错就停下并原样抛出，中止触发该事件的操作。 */
  emit(event: HookEvent, kernel: any, data: any): Promise<void>;
}

export class HookRegistry implements HookRegistryApi {
  private hooks: ProjectHook[] = [];

  public register(hook: ProjectHook): void {
    this.hooks.push(hook);
  }

  public list(): ProjectHook[] {
    return [...this.hooks];
  }

  public async emit(event: HookEvent, kernel: any, data: any): Promise<void> {
    for (const hook of this.hooks.filter((h) => h.event === event)) {
      await hook.run({ event, kernel, data });
    }
  }
}

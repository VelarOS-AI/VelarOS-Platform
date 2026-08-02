import type { HookEvent, ProjectHook } from "../types/hook.js";

export class HookRegistry {
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

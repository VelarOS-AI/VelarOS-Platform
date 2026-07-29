import type { HookEvent, WorkspaceHook } from "../types/hook.js";

export class HookRegistry {
  private hooks: WorkspaceHook[] = [];

  public register(hook: WorkspaceHook): void {
    this.hooks.push(hook);
  }

  public list(): WorkspaceHook[] {
    return [...this.hooks];
  }

  public async emit(event: HookEvent, kernel: any, data: any): Promise<void> {
    for (const hook of this.hooks.filter((h) => h.event === event)) {
      await hook.run({ event, kernel, data });
    }
  }
}

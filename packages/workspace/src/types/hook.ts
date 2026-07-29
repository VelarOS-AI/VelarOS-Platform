/** 可观察 workspace 操作前后发出的生命周期事件。 */
export type HookEvent =
  | "BeforeRead"
  | "AfterRead"
  | "BeforeSearch"
  | "AfterSearch"
  | "BeforeResolve"
  | "AfterResolve"
  | "BeforePrepareEdit"
  | "AfterPrepareEdit"
  | "BeforeApplyEdit"
  | "AfterApplyEdit"
  | "BeforeValidate"
  | "AfterValidate"
  | "BeforeRollback"
  | "AfterRollback";

export interface HookContext {
  event: HookEvent;
  /** 运行时内核实例；这里用 any 让插件包保持低耦合。 */
  kernel: any;
  data: any;
}

export interface WorkspaceHook {
  id: string;
  event: HookEvent;
  /** 有副作用的 hook；抛错会中止触发该事件的操作。 */
  run(ctx: HookContext): Promise<void> | void;
}

/**
 * 能力空间交出来的**操作表**：命名空间 → 操作名 → 怎么校验、怎么做。
 *
 * 这是 `CodeCapabilityPort` 的对偶——端口是「代码面要什么」，表是「空间给什么」，同一件事的两头。
 * 空间侧因此不必自己写一遍分发、校验与错误整形：那三件事每个空间一模一样，写一遍就够。
 *
 * **表里没有一个字是给模型看的。** 模型面是 `@AgentView` 从源码生成的那份声明，
 * 说明、示例、字段解释全在那里；表这一侧只剩校验与执行。
 * 工具时代把两者混在一个定义里，于是同一个形状写两遍（zod 一遍、TS 类型一遍），
 * 说明与类型各说各的——本轮查出来的模型面缺陷全是从那条缝里漏出来的。
 */

/**
 * 表里的一格：一个操作。
 *
 * `TInput` 是 `parse` 校验出来的那个形状，`run` 直接按它写——两者之间的衔接由类型保证，
 * 不必在 `run` 里再断言一次。表这一层收 `CapabilityOperation<any>`：一张表里各格形状本来就不同。
 */
export interface CapabilityOperation<TInput = never> {
  /**
   * 校验入参，顺带归一化。
   *
   * 代码面里比工具面更要紧：工具面一次调用错就是这一次失败，代码面里程序可能**已经做了 N 件事**
   * 才走到这一句。所以宁可在动手之前拦下来。返回的话要能让模型直接改对，不是「参数不合法」。
   */
  parse(input: unknown): { value: TInput } | { error: string }
  /** 真正做事。抛出来的异常由端口整形成程序里能 `try/catch` 的错误。 */
  run(input: TInput, signal?: AbortSignal): Promise<unknown>
}

/** 一个命名空间的操作表：操作名 → 那一格。 */
export type CapabilityNamespaceOperations = Readonly<Record<string, CapabilityOperation<any>>>

/** 整张表：命名空间 → 操作表。一个空间通常只登记自己那一个命名空间。 */
export type CapabilityOperationTable = Readonly<Record<string, CapabilityNamespaceOperations>>

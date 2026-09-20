import type { CodeAttachment } from './outcome.js'

/**
 * 能力空间交出来的**操作表**：命名空间 → 操作名 → 那个函数。
 *
 * 这是 `CodeCapabilityPort` 的对偶——端口是「代码面要什么」，表是「空间给什么」，同一件事的两头。
 * 空间侧因此不必自己写一遍分发与错误整形：那两件事每个空间一模一样，写一遍就够。
 *
 * **表里没有校验，也没有一个字是给模型看的。**
 * 说明在 `@AgentView` 生成的那份声明里；校验在**操作方法自己**里——入参合不合法是那件能力自己的事，
 * 它本来就要拦（路径不存在、文件太大、编码认不出），再在调用方这一侧盖一层 schema 只是第二个主人。
 * 而且盖在调用方那一侧的东西换个入口就漏：`run` 的 timeoutMs 一度只有 schema 在拦，
 * 绕开它直接调方法就没有上限——那个洞正是这么来的。
 */

/**
 * 一个操作：收模型给的入参，做事，交回结果。
 *
 * 入参标成 `any` 是诚实的：它刚从隔离进程过来，还没有人验过。
 * 方法自己的签名是有类型的（模型读的声明就从那个签名生成），由它自己把 `any` 收成那个类型。
 */
export type CapabilityOperation = (input: any, context: CapabilityOperationContext) => Promise<unknown>

/** 一次操作能用到的东西：取消信号，与把图交给模型的口子。 */
export interface CapabilityOperationContext {
  /** 本次调用的取消信号。 */
  signal?: AbortSignal
  /**
   * 交一张图给模型。图不进返回值——返回值是给程序的，程序看不了像素；
   * 交出去的图在程序跑完之后按顺序放到结果后面，模型看到的是真正的图。
   */
  attach(attachment: CodeAttachment): void
}

/** 一个命名空间的操作表：操作名 → 那个函数。 */
export type CapabilityNamespaceOperations = Readonly<Record<string, CapabilityOperation>>

/** 整张表：命名空间 → 操作表。一个空间通常只登记自己那一个命名空间。 */
export type CapabilityOperationTable = Readonly<Record<string, CapabilityNamespaceOperations>>
